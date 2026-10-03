import {
  BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Post, Query,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, In, LessThan, MoreThan, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import {
  Booking, BreakfastPrep, CleaningTask, Compensation, Incident, LinenDelivery, LinenItem,
  LinenShortage, MaintenanceTicket, Room, User,
} from '../entities';
import { addDays, round2, todayStr } from '../common/util';

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

  // 完成打扫：记录布草消耗（可用布草转入待洗）
  @Post('tasks/:id/complete')
  async complete(@Param('id') id: number, @Body() body: { linenUsed?: number; notes?: string }) {
    const t = await this.tasks.findOne({ where: { id } });
    if (!t) throw new NotFoundException('任务不存在');
    const used = body.linenUsed ?? 1;
    await this.dataSource.transaction(async (em) => {
      t.status = 'done';
      t.finishedAt = new Date();
      t.linenUsed = used;
      t.notes = body.notes || t.notes;
      await em.save(t);
      await em.update(Room, t.roomId, { status: 'clean' });
      if (used > 0) {
        const items = await em.find(LinenItem);
        for (const item of items) {
          const avail = item.total - item.inUse - item.inWash - item.damaged;
          const take = Math.min(avail, used);
          if (take > 0) {
            item.inWash += take;
            await em.save(item);
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
    @InjectRepository(LinenShortage) private shortages: Repository<LinenShortage>,
    @InjectRepository(Incident) private incidents: Repository<Incident>,
    @InjectRepository(Room) private rooms: Repository<Room>,
    @InjectRepository(Booking) private bookings: Repository<Booking>,
    @InjectRepository(Compensation) private compensations: Repository<Compensation>,
    private dataSource: DataSource,
  ) {}

  @Get('stock')
  stock() {
    return this.items.find({ order: { id: 'ASC' } }).then((rows) =>
      rows.map((r) => ({ ...r, available: r.total - r.inUse - r.inWash - r.damaged })));
  }

  @Get('deliveries')
  deliveryList() {
    return this.deliveries.find({ order: { expectedAt: 'DESC' } });
  }

  @Post('deliveries')
  createDelivery(@Body() body: { item: string; quantity: number; expectedAt: string }) {
    if (!body.item || !body.quantity || !body.expectedAt) throw new BadRequestException('参数不完整');
    return this.deliveries.save(this.deliveries.create({
      item: body.item, quantity: body.quantity, expectedAt: new Date(body.expectedAt), status: 'scheduled',
    }));
  }

  // 送洗布草返回：晚于预期 2 小时记布草延迟事件；
  // 布草到达后自动解除等待该布草的缺口，房态从「待布草」转为「已清洁（可入住）」
  @Post('deliveries/:id/arrive')
  async arrive(@Param('id') id: number) {
    const d = await this.deliveries.findOne({ where: { id } });
    if (!d) throw new NotFoundException('配送单不存在');
    if (d.status !== 'scheduled') throw new BadRequestException('该配送单已处理');
    const now = new Date();
    const late = now.getTime() > new Date(d.expectedAt).getTime() + 2 * 3600 * 1000;
    const resolvedRooms: string[] = [];
    await this.dataSource.transaction(async (em) => {
      d.arrivedAt = now;
      d.status = late ? 'delayed' : 'delivered';
      await em.save(d);
      const item = await em.findOne(LinenItem, { where: { item: d.item } });
      if (item) {
        item.inWash = Math.max(0, item.inWash - d.quantity);
        await em.save(item);
      }
      if (late) {
        await em.save(em.create(Incident, {
          type: 'linen_delay', bookingId: null, roomId: null,
          description: `布草「${d.item}」${d.quantity} 件延迟送达（应 ${new Date(d.expectedAt).toLocaleString('zh-CN')} 前到），影响保洁换布`,
          status: 'open', cost: 0,
        }));
      }
      // 解除等待该布草的缺口（含客人已调拨但房间仍待布草的），房态自动恢复可入住
      const affected = await em.find(LinenShortage, {
        where: { item: d.item, status: In(['waiting', 'relocated']) }, relations: ['room'],
      });
      for (const s of affected) {
        if (s.status === 'waiting') {
          s.status = 'resolved';
          s.resolvedAt = now;
          s.resolution = `布草「${d.item}」已送达，房间恢复可入住`;
          await em.save(s);
          await em.update(Incident, { roomId: s.roomId, type: 'linen_delay', status: 'open' }, {
            status: 'resolved', resolvedAt: now, resolution: '布草已送达，房间恢复可入住',
          });
        }
        const room = await em.findOne(Room, { where: { id: s.roomId } });
        if (room && room.status === 'awaiting_linen') {
          room.status = 'clean';
          await em.save(room);
          resolvedRooms.push(room.code);
        }
      }
    });
    return { ...d, resolvedRooms };
  }

  // ---------- 布草缺口（保洁完成但布草未到，房间待布草无法按时交付） ----------

  private async shortageView(rows: LinenShortage[]) {
    const bookingIds = [...new Set(rows.map((r) => r.bookingId).filter(Boolean))];
    const bookings = bookingIds.length
      ? await this.bookings.find({ where: { id: In(bookingIds as number[]) } })
      : [];
    const bMap = new Map(bookings.map((b) => [b.id, b]));
    const now = Date.now();
    return rows.map((s) => {
      const b = s.bookingId ? bMap.get(s.bookingId) : null;
      const end = s.status === 'waiting' ? now : new Date(s.resolvedAt || s.createdAt).getTime();
      return {
        ...s,
        roomCode: s.room?.code,
        roomType: (s.room as any)?.roomType?.name,
        bookingCode: b?.code || null,
        guestName: b?.guestName || null,
        waitingMinutes: Math.max(0, Math.round((end - new Date(s.waitingSince).getTime()) / 60000)),
      };
    });
  }

  @Get('shortages')
  async shortageList(@Query('status') status?: string) {
    const where: any = {};
    if (status) where.status = status;
    const rows = await this.shortages.find({
      where, relations: ['room', 'room.roomType'], order: { id: 'DESC' },
    });
    return this.shortageView(rows);
  }

  // 登记布草缺口：保洁完成但布草车未到，房间转「待布草」并记布草延迟事件
  @Post('shortages')
  async createShortage(@Body() body: {
    roomId: number; bookingId?: number; item: string; quantity?: number;
    expectedAt: string; waitingSince?: string; deliveryId?: number; note?: string;
  }) {
    if (!body.roomId || !body.item || !body.expectedAt) throw new BadRequestException('房间、缺口布草与预计到达时间必填');
    const room = await this.rooms.findOne({ where: { id: body.roomId }, relations: ['roomType'] });
    if (!room) throw new NotFoundException('房间不存在');
    const booking = body.bookingId
      ? await this.bookings.findOne({ where: { id: body.bookingId } })
      : await this.bookings.findOne({
          where: { roomId: room.id, checkIn: todayStr(), status: 'booked' },
        });
    return this.dataSource.transaction(async (em) => {
      const shortage = await em.save(em.create(LinenShortage, {
        roomId: room.id, bookingId: booking?.id || null, deliveryId: body.deliveryId || null,
        item: body.item, quantity: body.quantity || 1,
        expectedAt: new Date(body.expectedAt),
        waitingSince: body.waitingSince ? new Date(body.waitingSince) : new Date(),
        status: 'waiting',
      }));
      await em.update(Room, room.id, { status: 'awaiting_linen' });
      await em.save(em.create(Incident, {
        type: 'linen_delay', bookingId: booking?.id || null, roomId: room.id,
        description: `保洁已完成，但布草「${body.item}」未到（预计 ${new Date(body.expectedAt).toLocaleString('zh-CN')} 到），`
          + `${room.code} 房无法按时交付${booking ? `，客人${booking.guestName}等待入住` : ''}${body.note ? `：${body.note}` : ''}`,
        status: 'open', cost: 0,
      }));
      return shortage;
    });
  }

  // 可调拨房间：已清洁/已验收、且在等待订单住期内无冲突的房间（同房型优先）
  @Get('shortages/:id/alternatives')
  async alternatives(@Param('id') id: number) {
    const s = await this.shortages.findOne({ where: { id }, relations: ['room', 'room.roomType'] });
    if (!s) throw new NotFoundException('布草缺口记录不存在');
    const booking = s.bookingId ? await this.bookings.findOne({ where: { id: s.bookingId } }) : null;
    const rooms = await this.rooms.find({ relations: ['roomType'], order: { code: 'ASC' } });
    const result: any[] = [];
    for (const r of rooms) {
      if (r.id === s.roomId || !['clean', 'inspected'].includes(r.status)) continue;
      let conflict = false;
      if (booking) {
        const cnt = await this.bookings.count({
          where: {
            roomId: r.id, status: In(['booked', 'checked_in']),
            checkIn: LessThan(booking.checkOut), checkOut: MoreThan(booking.checkIn),
          },
        });
        conflict = cnt > 0;
      }
      if (!conflict) {
        result.push({
          roomId: r.id, code: r.code, status: r.status,
          typeName: r.roomType.name, sameType: r.roomTypeId === s.room.roomTypeId,
          basePrice: Number(r.roomType.basePrice),
        });
      }
    }
    result.sort((a, b) => (a.sameType === b.sameType ? a.code.localeCompare(b.code) : a.sameType ? -1 : 1));
    return { shortageId: s.id, fromRoom: s.room.code, bookingId: s.bookingId, rooms: result };
  }

  // 管家安抚/处置：下午茶、延迟入住补偿（计入当日运营成本）；或调拨换房（订单换到可入住房）
  @Post('shortages/:id/compensate')
  async compensate(@Param('id') id: number, @Body() body: {
    action: 'afternoon_tea' | 'late_checkin' | 'room_change';
    amount?: number; toRoomId?: number; note?: string;
  }) {
    const s = await this.shortages.findOne({ where: { id }, relations: ['room'] });
    if (!s) throw new NotFoundException('布草缺口记录不存在');
    if (s.status !== 'waiting') throw new BadRequestException('该缺口已处理，无需补偿或调拨');
    const booking = s.bookingId ? await this.bookings.findOne({ where: { id: s.bookingId } }) : null;

    if (body.action === 'room_change') {
      if (!booking) throw new BadRequestException('该缺口无关联订单，无需调拨');
      if (!body.toRoomId) throw new BadRequestException('请选择调拨目标房间');
      const target = await this.rooms.findOne({ where: { id: body.toRoomId }, relations: ['roomType'] });
      if (!target) throw new NotFoundException('目标房间不存在');
      if (!['clean', 'inspected'].includes(target.status)) throw new BadRequestException('目标房间不可入住');
      const conflict = await this.bookings.count({
        where: {
          roomId: target.id, status: In(['booked', 'checked_in']),
          checkIn: LessThan(booking.checkOut), checkOut: MoreThan(booking.checkIn),
        },
      });
      if (conflict) throw new BadRequestException('目标房间在该住期已有订单，无法调拨');
      await this.dataSource.transaction(async (em) => {
        const fromCode = s.room.code;
        booking.roomId = target.id;
        booking.roomTypeId = target.roomTypeId;
        await em.save(booking);
        s.status = 'relocated';
        s.resolvedAt = new Date();
        s.resolution = `客人已调拨：${fromCode} → ${target.code}（${target.roomType.name}），原房间仍待布草`;
        await em.save(s);
        await em.update(Incident, { bookingId: booking.id, type: 'linen_delay', status: 'open' }, {
          status: 'resolved', resolvedAt: new Date(),
          resolution: `已调拨换房 ${fromCode} → ${target.code}，客人先行入住`,
        });
      });
      return { shortage: s, booking, compensation: null };
    }

    if (!['afternoon_tea', 'late_checkin'].includes(body.action)) {
      throw new BadRequestException('不支持的处置方式（afternoon_tea/late_checkin/room_change）');
    }
    const amount = body.amount ?? (body.action === 'afternoon_tea' ? 68 : 200);
    if (amount <= 0) throw new BadRequestException('补偿金额需大于 0');
    const incident = await this.incidents.findOne({
      where: { roomId: s.roomId, type: 'linen_delay', status: 'open' },
    });
    const comp = await this.saveShortageCompensation(s, booking, incident, body.action, amount, body.note);
    return { shortage: s, booking, compensation: comp };
  }

  private async saveShortageCompensation(s: LinenShortage, booking: Booking | null, incident: Incident | null,
                                         action: string, amount: number, note?: string) {
    const actionText = action === 'afternoon_tea' ? '下午茶安抚' : '延迟入住补偿';
    return this.compensations.save(this.compensations.create({
      reviewId: null, incidentId: incident?.id || null, bookingId: booking?.id || s.bookingId || null,
      type: action, amount: round2(amount), voucherCode: null, status: 'issued',
      reason: `布草延迟影响入住·${actionText}（${s.room.code}房）${note ? `：${note}` : ''}`,
    }));
  }

  // 布草延迟多次出现 → 提示增加安全库存 / 调整洗涤供应商 / 限制高峰连住订单
  @Get('delay-advice')
  async delayAdvice() {
    const incidents = await this.incidents.find({ where: { type: 'linen_delay' } });
    const delayCount = incidents.length;
    const deliveries = await this.deliveries.find();
    const now = new Date();
    const delayed = deliveries.filter((d) =>
      d.status === 'delayed' || (d.status === 'scheduled' && new Date(d.expectedAt) < now));
    const delayRate = deliveries.length ? delayed.length / deliveries.length : 0;
    const items = await this.items.find();
    const lowStock = items
      .map((i) => ({ item: i.item, available: i.total - i.inUse - i.inWash - i.damaged }))
      .filter((x) => x.available < 20);
    const bookings = await this.bookings.find();
    const multiNight = bookings.filter((b) => b.status !== 'cancelled' && b.nights >= 3);
    const waiting = await this.shortages.count({ where: { status: 'waiting' } });

    const suggestions: any[] = [];
    if (delayCount >= 2) {
      suggestions.push({
        type: 'safety_stock', title: '增加布草安全库存',
        evidence: `旺季已发生 ${delayCount} 起布草延迟${waiting ? `，当前仍有 ${waiting} 间客房待布草` : ''}；`
          + (lowStock.length ? lowStock.map((x) => `「${x.item}」可用仅 ${x.available} 件`).join('，') : '当前各类布草可用量尚可'),
        suggestion: '按高峰日消耗 2 倍储备安全库存，优先补齐床单/被套；与洗涤厂约定旺季每日两送',
      });
      if (delayRate >= 0.3 || delayed.length >= 2) {
        suggestions.push({
          type: 'supplier', title: '调整洗涤供应商',
          evidence: `送洗配送 ${deliveries.length} 单中 ${delayed.length} 单延迟（延迟率 ${round2(delayRate * 100)}%），山路运输不稳定`,
          suggestion: '引入备用洗涤供应商分流，或将送洗批次提前至前一日晚间，避开白天山路拥堵时段',
        });
      }
      if (multiNight.length >= 3) {
        suggestions.push({
          type: 'limit_long_stay', title: '限制高峰连住订单',
          evidence: `旺季连住≥3晚订单 ${multiNight.length} 张，入住首日集中换洗使布草需求峰值叠加延迟风险`,
          suggestion: '高峰日限制连住≥3晚订单占比，或连住订单改为隔日换洗，削平单日布草换洗峰值',
        });
      }
    }
    return {
      delayCount, waitingShortages: waiting,
      deliveries: { total: deliveries.length, delayed: delayed.length, delayRate: round2(delayRate * 100) },
      multiNightCount: multiNight.length, suggestions,
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
    CleaningTask, Room, User, Booking, LinenItem, LinenDelivery, LinenShortage,
    MaintenanceTicket, BreakfastPrep, Incident, Compensation,
  ])],
  controllers: [CleaningController, LinenController, MaintenanceController, BreakfastController],
})
export class OpsModule {}
