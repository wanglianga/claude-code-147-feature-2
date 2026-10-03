import {
  BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Post, Query,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import {
  Booking, BreakfastPrep, CleaningTask, Compensation, DailyInventory, Incident, LinenAction,
  LinenBlock, LinenDelivery, LinenItem, MaintenanceTicket, Room, User,
} from '../entities';
import { addDays, round2, todayStr } from '../common/util';

// 布草阻塞（待布草）领域服务：房态、缺口事件、到达自动恢复都收敛在这里
class LinenBlockService {
  // 推荐可调拨房间：同房型、当前可交付、且客人入住当晚无在住/预订占用
  async recommendTransfers(
    em: EntityManager, roomTypeId: number, checkIn: string, checkOut: string, excludeRoomId?: number,
  ): Promise<Room[]> {
    const candidates = await em.find(Room, {
      where: { roomTypeId, status: In(['clean', 'inspected']) },
      order: { code: 'ASC' },
    });
    const occupied = await em.find(Booking, {
      where: { status: In(['booked', 'checked_in']) },
    });
    return candidates.filter((r) => {
      if (excludeRoomId && r.id === excludeRoomId) return false;
      // 与目标入住区间有重叠即不可调拨
      return !occupied.some((b) => b.roomId === r.id && b.checkIn < checkOut && b.checkOut > checkIn);
    });
  }

  // 登记待布草：房态转 awaiting_linen，记录缺口/ETA/等待时间/可调拨房间，并生成布草延迟事件
  async openBlock(em: EntityManager, p: {
    roomId: number; bookingId?: number | null; deliveryId?: number | null;
    item?: string; shortage?: number; expectedAt: Date; waitMinutes?: number;
    transferRoomIds?: number[]; note?: string;
  }) {
    const room = await em.findOne(Room, { where: { id: p.roomId }, relations: ['roomType'] });
    if (!room) throw new NotFoundException('房间不存在');
    const exist = await em.findOne(LinenBlock, { where: { roomId: p.roomId, status: In(['active', 'reassigned']) } });
    if (exist) throw new BadRequestException(`${room.code} 房已处于待布草状态，布草到达后自动恢复`);

    const booking = p.bookingId ? await em.findOne(Booking, { where: { id: p.bookingId } }) : null;
    const now = new Date();
    let transferIds = p.transferRoomIds || [];
    if (booking) {
      const suggested = await this.recommendTransfers(em, room.roomTypeId, booking.checkIn, booking.checkOut, room.id);
      if (!transferIds.length) transferIds = suggested.map((r) => r.id);
    }
    const waitMinutes = p.waitMinutes ?? Math.max(0, Math.round((p.expectedAt.getTime() - now.getTime()) / 60000));
    const incident = await em.save(em.create(Incident, {
      type: 'linen_delay', bookingId: booking?.id || null, roomId: room.id,
      description: `布草车堵车未到，${room.code} 房保洁已完成但缺「${p.item || '整套布草'}」${p.shortage ?? 1} 套，`
        + `预计 ${p.expectedAt.toLocaleString('zh-CN')} 到达，客人约等待 ${waitMinutes} 分钟，房间暂无法交付`
        + (transferIds.length ? `；可调拨房间 ${transferIds.length} 间` : '；暂无同房型可调拨房间'),
      status: 'open', cost: 0,
    }));
    const block = await em.save(em.create(LinenBlock, {
      roomId: room.id, bookingId: booking?.id || null, deliveryId: p.deliveryId || null,
      incidentId: incident.id, item: p.item || '整套布草', shortage: p.shortage ?? 1,
      expectedAt: p.expectedAt, blockedSince: now, status: 'active',
      waitMinutes, transferRoomIds: transferIds.join(','), note: p.note || '',
    }));
    await em.update(Room, room.id, { status: 'awaiting_linen' });
    return block;
  }

  // 布草到达：待布草房自动转为可入住（已验收），关闭事件并写入实际等待时间
  async resolveByDelivery(em: EntityManager, delivery: LinenDelivery) {
    const blocks = await em.find(LinenBlock, { where: { status: In(['active', 'reassigned']) } });
    const hit = blocks.filter((b) =>
      b.deliveryId === delivery.id || (!b.deliveryId && b.item === delivery.item));
    for (const b of hit) {
      const now = new Date();
      b.status = 'resolved';
      b.resolvedAt = now;
      b.waitMinutes = Math.max(0, Math.round((now.getTime() - new Date(b.blockedSince).getTime()) / 60000));
      await em.save(b);
      await em.update(Room, b.roomId, { status: 'inspected' });
      if (b.incidentId) {
        const comps = await em.find(Compensation, { where: { linenBlockId: b.id } });
        const compTotal = comps.reduce((s, c) => s + Number(c.amount), 0);
        await em.update(Incident, { id: b.incidentId }, {
          status: 'resolved', resolvedAt: now,
          resolution: `布草已到达，房态自动转为可入住；客人实际等待 ${b.waitMinutes} 分钟`
            + (compTotal > 0 ? `，待客补偿 ¥${round2(compTotal)} 计入当日运营成本` : ''),
        });
      }
    }
    return hit;
  }
}

// ================= 保洁 =================
@Controller('cleaning')
export class CleaningController {
  constructor(
    @InjectRepository(CleaningTask) private tasks: Repository<CleaningTask>,
    @InjectRepository(Room) private rooms: Repository<Room>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Booking) private bookings: Repository<Booking>,
    @InjectRepository(LinenItem) private linen: Repository<LinenItem>,
    @InjectRepository(MaintenanceTicket) private maintenance: Repository<MaintenanceTicket>,
    @InjectRepository(LinenDelivery) private deliveries: Repository<LinenDelivery>,
    private linenBlocks: LinenBlockService,
    private dataSource: DataSource,
  ) {}

  @Get('tasks')
  list(@Query('date') date?: string, @Query('status') status?: string) {
    const where: any = {};
    if (date) where.date = date;
    if (status) where.status = status;
    return this.tasks.find({ where, relations: ['room', 'assignee'], order: { id: 'DESC' } });
  }

  // 智能排班：按下一单入住时间、脏污程度、维修状态、布草库存安排打扫顺序与人员
  @Post('auto-schedule')
  async autoSchedule(@Body() body: { date?: string }) {
    const date = body.date || todayStr();
    const pending = await this.tasks.find({
      where: [{ status: 'pending' }, { status: 'assigned' }],
      relations: ['room'],
    });
    const cleaners = await this.users.find({ where: { role: 'cleaner' } });
    if (!cleaners.length) throw new BadRequestException('没有可用的保洁员');
    const linenItems = await this.linen.find();
    const linenAvailable = linenItems.length
      ? Math.min(...linenItems.map((l) => l.total - l.inUse - l.inWash - l.damaged))
      : 0;
    const durationOf = (d: string) => (d === 'heavy' ? 70 : d === 'light' ? 30 : 45);
    const dirtWeight = (d: string) => (d === 'heavy' ? 2 : d === 'normal' ? 1 : 0);

    const plans: any[] = [];
    for (const t of pending) {
      const next = await this.bookings.findOne({
        where: { roomId: t.roomId, checkIn: MoreThanOrEqual(date), status: In(['booked', 'checked_in']) },
        order: { checkIn: 'ASC' },
      });
      const openFix = await this.maintenance.findOne({
        where: { roomId: t.roomId, status: In(['open', 'fixing']) },
      });
      plans.push({
        task: t,
        deadline: next ? `${next.checkIn}T14:00` : null,
        warnings: [
          ...(openFix ? [`存在未结维修单（${openFix.description}），需先维修`] : []),
          ...(linenAvailable < 1 ? ['布草库存不足，更换布草受限'] : []),
        ],
      });
    }
    // 紧急程度：有当日入住的最优先，其次按脏污
    plans.sort((a, b) => {
      const da = a.deadline || '9999';
      const db = b.deadline || '9999';
      if (da !== db) return da < db ? -1 : 1;
      return dirtWeight(b.task.dirtiness) - dirtWeight(a.task.dirtiness);
    });
    const load = new Map<number, number>(cleaners.map((c) => [c.id, 0]));
    const result: any[] = [];
    let seq = 1;
    for (const p of plans) {
      const cleaner = cleaners.reduce((a, b) => (load.get(a.id)! <= load.get(b.id)! ? a : b));
      const startMin = 9 * 60 + load.get(cleaner.id)!;
      const start = new Date(`${date}T${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}:00+08:00`);
      const duration = durationOf(p.task.dirtiness);
      p.task.assigneeId = cleaner.id;
      p.task.scheduledStart = start;
      p.task.status = 'assigned';
      p.task.priority = seq++;
      await this.tasks.save(p.task);
      load.set(cleaner.id, load.get(cleaner.id)! + duration);
      result.push({
        taskId: p.task.id, room: p.task.room.code, dirtiness: p.task.dirtiness,
        cleaner: cleaner.name, start: start.toISOString(), durationMin: duration,
        deadline: p.deadline, warnings: p.warnings,
      });
    }
    return { date, linenAvailable, plan: result };
  }

  @Post('tasks/:id/assign')
  async assign(@Param('id') id: number, @Body() body: { cleanerId: number }) {
    const t = await this.tasks.findOne({ where: { id } });
    if (!t) throw new NotFoundException('任务不存在');
    t.assigneeId = body.cleanerId;
    t.status = 'assigned';
    return this.tasks.save(t);
  }

  @Post('tasks/:id/start')
  async start(@Param('id') id: number) {
    const t = await this.tasks.findOne({ where: { id } });
    if (!t) throw new NotFoundException('任务不存在');
    t.status = 'in_progress';
    t.startedAt = new Date();
    await this.rooms.update(t.roomId, { status: 'cleaning' });
    return this.tasks.save(t);
  }

  // 完成打扫：有可用布草则换布入库；布草车未到/库存不足则房间转「待布草」并登记阻塞
  @Post('tasks/:id/complete')
  async complete(@Param('id') id: number, @Body() body: { linenUsed?: number; notes?: string }) {
    const t = await this.tasks.findOne({ where: { id }, relations: ['room'] });
    if (!t) throw new NotFoundException('任务不存在');
    const used = body.linenUsed ?? 1;
    await this.dataSource.transaction(async (em) => {
      t.status = 'done';
      t.finishedAt = new Date();
      t.linenUsed = used;
      t.notes = body.notes || t.notes;
      await em.save(t);

      const items = await em.find(LinenItem);
      const shortageItem = used > 0
        ? items.find((item) => item.total - item.inUse - item.inWash - item.damaged < used)
        : null;
      if (shortageItem) {
        // 布草不足：打扫完成但无法换布，房间转待布草
        const delivery = await em.findOne(LinenDelivery, {
          where: { item: shortageItem.item, status: 'scheduled' },
          order: { expectedAt: 'ASC' },
        });
        const booking = await em.findOne(Booking, {
          where: { roomId: t.roomId, status: In(['booked', 'checked_in']) },
          order: { checkIn: 'ASC' },
        });
        await this.linenBlocks.openBlock(em, {
          roomId: t.roomId, bookingId: booking?.id, deliveryId: delivery?.id,
          item: shortageItem.item, shortage: used,
          expectedAt: delivery?.expectedAt || new Date(Date.now() + 3 * 3600 * 1000),
          note: `保洁任务 #${t.id} 完成时库存不足自动登记`,
        });
      } else {
        await em.update(Room, t.roomId, { status: 'clean' });
        if (used > 0) {
          const rows = await em.find(LinenItem);
          for (const item of rows) {
            const avail = item.total - item.inUse - item.inWash - item.damaged;
            const take = Math.min(avail, used);
            if (take > 0) {
              item.inWash += take;
              await em.save(item);
            }
          }
        }
      }
    });
    return this.tasks.findOne({ where: { id }, relations: ['room', 'assignee'] });
  }

  @Post('tasks/:id/inspect')
  async inspect(@Param('id') id: number) {
    const t = await this.tasks.findOne({ where: { id } });
    if (!t) throw new NotFoundException('任务不存在');
    if (t.status !== 'done') throw new BadRequestException('任务尚未完成');
    const room = await this.rooms.findOne({ where: { id: t.roomId } });
    if (room?.status === 'awaiting_linen') {
      throw new BadRequestException('布草车尚未到达，房间为待布草状态，暂不可验收交付');
    }
    t.status = 'inspected';
    await this.rooms.update(t.roomId, { status: 'inspected' });
    return this.tasks.save(t);
  }
}

// ================= 布草 =================
@Controller('linen')
export class LinenController {
  constructor(
    @InjectRepository(LinenItem) private items: Repository<LinenItem>,
    @InjectRepository(LinenDelivery) private deliveries: Repository<LinenDelivery>,
    @InjectRepository(LinenBlock) private blocks: Repository<LinenBlock>,
    @InjectRepository(Compensation) private compensations: Repository<Compensation>,
    @InjectRepository(Booking) private bookings: Repository<Booking>,
    @InjectRepository(Room) private rooms: Repository<Room>,
    @InjectRepository(Incident) private incidents: Repository<Incident>,
    private linenBlocks: LinenBlockService,
    private dataSource: DataSource,
  ) {}

  @Get('stock')
  stock() {
    return this.items.find({ order: { id: 'ASC' } }).then((rows) =>
      rows.map((r) => ({
        ...r,
        available: r.total - r.inUse - r.inWash - r.damaged,
        belowSafety: r.total - r.inUse - r.inWash - r.damaged <= r.safetyStock,
      })));
  }

  // 设置某类布草的安全库存
  @Post('stock/:id/safety')
  async setSafety(@Param('id') id: number, @Body() body: { safetyStock: number }) {
    const item = await this.items.findOne({ where: { id } });
    if (!item) throw new NotFoundException('布草不存在');
    item.safetyStock = Math.max(0, Math.floor(body.safetyStock || 0));
    return this.items.save(item);
  }

  @Get('deliveries')
  deliveryList() {
    return this.deliveries.find({ order: { expectedAt: 'DESC' } });
  }

  @Post('deliveries')
  createDelivery(@Body() body: {
    item: string; quantity: number; expectedAt: string; reason?: string; supplier?: string;
  }) {
    if (!body.item || !body.quantity || !body.expectedAt) throw new BadRequestException('参数不完整');
    return this.deliveries.save(this.deliveries.create({
      item: body.item, quantity: body.quantity, expectedAt: new Date(body.expectedAt),
      status: 'scheduled', reason: body.reason || '', supplier: body.supplier || '',
    }));
  }

  // 待布草房间列表：缺口、预计到达、可调拨房间、客人等待时间、已发补偿
  @Get('blocks')
  async blockList(@Query('status') status?: string) {
    const rows = await this.blocks.find({
      where: status ? { status } : {},
      relations: ['room'], order: { id: 'DESC' },
    });
    return Promise.all(rows.map(async (b) => this.decorateBlock(b)));
  }

  private async decorateBlock(b: LinenBlock) {
    const booking = b.bookingId ? await this.bookings.findOne({ where: { id: b.bookingId } }) : null;
    const delivery = b.deliveryId ? await this.deliveries.findOne({ where: { id: b.deliveryId } }) : null;
    const transferIds = b.transferRoomIds.split(',').filter(Boolean).map(Number);
    const transferRooms = transferIds.length
      ? await this.rooms.find({ where: { id: In(transferIds) }, relations: ['roomType'] })
      : [];
    const comps = await this.compensations.find({ where: { linenBlockId: b.id } });
    const now = Date.now();
    const waited = b.status === 'active'
      ? Math.max(b.waitMinutes, Math.round((now - new Date(b.blockedSince).getTime()) / 60000))
      : b.waitMinutes;
    return {
      ...b,
      booking: booking ? {
        id: booking.id, code: booking.code, guestName: booking.guestName,
        checkIn: booking.checkIn, checkOut: booking.checkOut,
      } : null,
      delivery: delivery ? { id: delivery.id, status: delivery.status, expectedAt: delivery.expectedAt } : null,
      transferRooms: transferRooms.map((r) => ({ id: r.id, code: r.code, typeName: r.roomType.name, status: r.status })),
      compensations: comps,
      compensationTotal: round2(comps.reduce((s, c) => s + Number(c.amount), 0)),
      waitedMinutes: waited,
    };
  }

  // 管家登记布草缺口阻塞（也可由保洁完成自动触发）
  @Post('blocks')
  async createBlock(@Body() body: {
    roomId: number; bookingId?: number; deliveryId?: number; item?: string; shortage?: number;
    expectedAt: string; waitMinutes?: number; transferRoomIds?: number[]; note?: string;
  }) {
    if (!body.roomId || !body.expectedAt) throw new BadRequestException('房间与布草预计到达时间必填');
    const block = await this.dataSource.transaction((em) =>
      this.linenBlocks.openBlock(em, {
        roomId: body.roomId, bookingId: body.bookingId, deliveryId: body.deliveryId,
        item: body.item, shortage: body.shortage, expectedAt: new Date(body.expectedAt),
        waitMinutes: body.waitMinutes, transferRoomIds: body.transferRoomIds, note: body.note,
      }));
    return this.blocks.findOne({ where: { id: block.id } }).then((r) => this.decorateBlock(r!));
  }

  // 管家待客补偿：下午茶 / 延迟入住折扣（换房走 /room-change）
  @Post('blocks/:id/compensate')
  async compensate(@Param('id') id: number, @Body() body: {
    type: string; amount: number; note?: string;
  }) {
    const block = await this.blocks.findOne({ where: { id } });
    if (!block) throw new NotFoundException('待布草记录不存在');
    if (!['afternoon_tea', 'late_checkin'].includes(body.type)) {
      throw new BadRequestException('补偿类型需为 afternoon_tea / late_checkin；换房请用房调整接口');
    }
    if (!body.amount || body.amount <= 0) throw new BadRequestException('补偿金额需大于 0');
    const label = body.type === 'afternoon_tea' ? '下午茶' : '延迟入住补偿';
    const comp = await this.compensations.save(this.compensations.create({
      linenBlockId: block.id, bookingId: block.bookingId, incidentId: block.incidentId,
      type: body.type, amount: round2(body.amount), status: 'issued',
      reason: `布草延迟待客·${label}${body.note ? `：${body.note}` : ''}`,
    }));
    return comp;
  }

  // 换房调拨：把客人订单调到可调拨房间，记录换房成本，原房继续等待布草
  @Post('blocks/:id/room-change')
  async roomChange(@Param('id') id: number, @Body() body: { targetRoomId: number; amount?: number; note?: string }) {
    const block = await this.blocks.findOne({ where: { id } });
    if (!block) throw new NotFoundException('待布草记录不存在');
    if (block.status !== 'active') throw new BadRequestException('该待布草记录已处理');
    const target = await this.rooms.findOne({ where: { id: body.targetRoomId }, relations: ['roomType'] });
    if (!target) throw new NotFoundException('目标房间不存在');
    const allowed = block.transferRoomIds.split(',').filter(Boolean).map(Number);
    if (!allowed.includes(target.id)) throw new BadRequestException('目标房间不在可调拨房间范围内');
    return this.dataSource.transaction(async (em) => {
      const comp = await em.save(em.create(Compensation, {
        linenBlockId: block.id, bookingId: block.bookingId, incidentId: block.incidentId,
        type: 'room_change', amount: round2(body.amount || 0), status: 'issued',
        reason: `布草延迟换房：客人调至 ${target.code} 房（${target.roomType.name}）${body.note ? `：${body.note}` : ''}`,
      }));
      if (block.bookingId) {
        const bk = await em.findOne(Booking, { where: { id: block.bookingId } });
        if (bk) {
          // 同步两房型每日库存占用：原房型释放、新房型承接
          for (let d = bk.checkIn; d < bk.checkOut; d = addDays(d, 1)) {
            await em.decrement(DailyInventory, { roomTypeId: bk.roomTypeId, date: d }, 'booked', 1);
            await em.increment(DailyInventory, { roomTypeId: target.roomTypeId, date: d }, 'booked', 1);
          }
          bk.roomId = target.id;
          bk.roomTypeId = target.roomTypeId;
          await em.save(bk);
        }
      }
      block.status = 'reassigned';
      block.note = `${block.note ? `${block.note}\n` : ''}已换房至 ${target.code}`;
      await em.save(block);
      if (block.incidentId) {
        await em.update(Incident, { id: block.incidentId }, {
          status: 'resolved', resolvedAt: new Date(),
          resolution: `已为客人换房至 ${target.code}；原房继续等待布草，到达后自动恢复可入住`,
        });
      }
      return comp;
    });
  }

  // 送洗布草返回：晚于预期 2 小时记布草延迟；到达后待布草房自动转为可入住
  @Post('deliveries/:id/arrive')
  async arrive(@Param('id') id: number) {
    const d = await this.deliveries.findOne({ where: { id } });
    if (!d) throw new NotFoundException('配送单不存在');
    if (d.status !== 'scheduled') throw new BadRequestException('该配送单已处理');
    const now = new Date();
    const late = now.getTime() > new Date(d.expectedAt).getTime() + 2 * 3600 * 1000;
    let resolvedBlocks: LinenBlock[] = [];
    await this.dataSource.transaction(async (em) => {
      d.arrivedAt = now;
      d.status = late ? 'delayed' : 'delivered';
      await em.save(d);
      const item = await em.findOne(LinenItem, { where: { item: d.item } });
      if (item) {
        item.inWash = Math.max(0, item.inWash - d.quantity);
        await em.save(item);
      }
      resolvedBlocks = await this.linenBlocks.resolveByDelivery(em, d);
      // 延迟且本次到达没有对应待布草房时，补一条独立的布草延迟事件
      if (late && !resolvedBlocks.length) {
        await em.save(em.create(Incident, {
          type: 'linen_delay', bookingId: null, roomId: null,
          description: `布草「${d.item}」${d.quantity} 件延迟送达（应 ${new Date(d.expectedAt).toLocaleString('zh-CN')} 前到`
            + `${d.reason ? `，原因：${d.reason}` : ''}），影响保洁换布`,
          status: 'open', cost: 0,
        }));
      }
    });
    return { delivery: d, resolvedBlockIds: resolvedBlocks.map((b) => b.id) };
  }

  // 当日运营成本：布草延迟待客补偿 + 履约事件成本
  @Get('ops-cost')
  async opsCost(@Query('date') date?: string) {
    const d = date || todayStr();
    const blocks = await this.blocks.find();
    const todayBlocks = blocks.filter((b) => new Date(b.blockedSince).toISOString().slice(0, 10) === d
      || (b.resolvedAt && new Date(b.resolvedAt).toISOString().slice(0, 10) === d));
    const allComps = await this.compensations.find();
    const linenComps = allComps.filter((c) => c.linenBlockId && todayBlocks.some((b) => b.id === c.linenBlockId));
    const byType: Record<string, number> = {};
    for (const c of linenComps) byType[c.type] = round2((byType[c.type] || 0) + Number(c.amount));
    const incidents = await this.incidents.find();
    const incidentCost = incidents
      .filter((i) => i.occurredAt.toISOString().slice(0, 10) === d)
      .reduce((s, i) => s + Number(i.cost), 0);
    const linenCompTotal = round2(linenComps.reduce((s, c) => s + Number(c.amount), 0));
    return {
      date: d,
      linenGuestCompensation: linenCompTotal,
      byType,
      activeBlockCount: blocks.filter((b) => b.status === 'active').length,
      resolvedToday: todayBlocks.filter((b) => b.status === 'resolved').length,
      incidentCost: round2(incidentCost),
      total: round2(linenCompTotal + incidentCost),
    };
  }
}

// ================= 维修 =================
@Controller('maintenance')
export class MaintenanceController {
  constructor(
    @InjectRepository(MaintenanceTicket) private tickets: Repository<MaintenanceTicket>,
    @InjectRepository(Room) private rooms: Repository<Room>,
  ) {}

  @Get()
  list() {
    return this.tickets.find({ relations: ['room'], order: { id: 'DESC' } });
  }

  @Post()
  async create(@Body() body: { roomId: number; type: string; description: string; bookingId?: number; cost?: number }) {
    if (!body.roomId || !body.description) throw new BadRequestException('参数不完整');
    const t = await this.tickets.save(this.tickets.create({
      roomId: body.roomId, type: body.type || 'other', description: body.description,
      bookingId: body.bookingId || null, cost: body.cost || 0, status: 'open',
    }));
    await this.rooms.update(body.roomId, { status: 'maintenance' });
    return t;
  }

  @Post(':id/start')
  async start(@Param('id') id: number) {
    const t = await this.tickets.findOne({ where: { id } });
    if (!t) throw new NotFoundException('工单不存在');
    t.status = 'fixing';
    return this.tickets.save(t);
  }

  // 修复：房间转为待打扫，重新进入保洁链路
  @Post(':id/resolve')
  async resolve(@Param('id') id: number, @Body() body: { cost?: number }) {
    const t = await this.tickets.findOne({ where: { id } });
    if (!t) throw new NotFoundException('工单不存在');
    t.status = 'fixed';
    t.fixedAt = new Date();
    if (body.cost !== undefined) t.cost = body.cost;
    await this.tickets.save(t);
    await this.rooms.update(t.roomId, { status: 'dirty' });
    return t;
  }
}

// ================= 早餐 =================
@Controller('breakfast')
export class BreakfastController {
  constructor(
    @InjectRepository(Booking) private bookings: Repository<Booking>,
    @InjectRepository(BreakfastPrep) private preps: Repository<BreakfastPrep>,
    @InjectRepository(Incident) private incidents: Repository<Incident>,
  ) {}

  // 备餐计划：当早在住客人的份数与忌口汇总（入住日次日起到离店日当天供应）
  @Get('plan')
  async plan(@Query('date') date?: string) {
    const d = date || addDays(todayStr(), 1);
    const all = await this.bookings.find({ relations: ['room', 'roomType'] });
    const serving = all.filter((b) => b.status !== 'cancelled' && b.checkIn < d && b.checkOut >= d && b.breakfastCount > 0);
    const required = serving.reduce((s, b) => s + b.breakfastCount, 0);
    const prep = await this.preps.findOne({ where: { date: d } });
    return {
      date: d,
      supplyWindow: '07:00 - 09:30',
      required,
      prepared: prep?.preparedPortions ?? 0,
      status: prep?.status ?? 'planned',
      dietary: serving.filter((b) => b.dietaryNotes).map((b) => ({
        bookingCode: b.code, guest: b.guestName, room: b.room.code, notes: b.dietaryNotes, portions: b.breakfastCount,
      })),
      bookings: serving.map((b) => ({
        code: b.code, guest: b.guestName, room: b.room.code, portions: b.breakfastCount, dietary: b.dietaryNotes,
      })),
    };
  }

  // 厨房确认备餐量：不足则记早餐供应不足事件
  @Post('confirm')
  async confirm(@Body() body: { date: string; prepared: number; note?: string }) {
    if (!body.date || body.prepared === undefined) throw new BadRequestException('参数不完整');
    const plan = await this.plan(body.date);
    let prep = await this.preps.findOne({ where: { date: body.date } });
    if (!prep) prep = this.preps.create({ date: body.date });
    prep.requiredPortions = plan.required;
    prep.preparedPortions = body.prepared;
    prep.note = body.note || '';
    prep.confirmedAt = new Date();
    prep.status = body.prepared >= plan.required ? 'confirmed' : 'shortage';
    await this.preps.save(prep);
    if (prep.status === 'shortage') {
      await this.incidents.save(this.incidents.create({
        type: 'breakfast_shortage', bookingId: null, roomId: null,
        description: `${body.date} 早餐供应不足：需求 ${plan.required} 份，实际备餐 ${body.prepared} 份，缺口 ${plan.required - body.prepared} 份`,
        status: 'open', cost: 0,
      }));
    }
    return prep;
  }

  @Get('records')
  records() {
    return this.preps.find({ order: { date: 'DESC' } });
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([
    CleaningTask, Room, User, Booking, LinenItem, LinenDelivery, LinenBlock, LinenAction,
    MaintenanceTicket, BreakfastPrep, Incident, Compensation, DailyInventory,
  ])],
  controllers: [CleaningController, LinenController, MaintenanceController, BreakfastController],
  providers: [LinenBlockService],
})
export class OpsModule {}
