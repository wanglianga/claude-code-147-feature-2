import { Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import {
  ALL_ENTITIES, Booking, BreakfastPrep, Channel, CleaningTask, Compensation,
  DailyInventory, DailyPrice, Incident, LinenBlock, LinenDelivery, LinenItem,
  MaintenanceTicket, Review, Room, RoomType, User,
} from './entities';
import { eachDay, round2 } from './common/util';

/**
 * 种子数据：2026 国庆旺季（10-01 ~ 10-08），今天为 10-03。
 * 覆盖完整住宿链路：多渠道订单、保洁、布草、维修、早餐、
 * 延迟退房/空调故障/布草延迟/临时加人/宠物损坏/早餐不足/超卖/差评与补偿。
 */
@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private log = new Logger('Seed');
  constructor(
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(RoomType) private types: Repository<RoomType>,
    @InjectRepository(Room) private rooms: Repository<Room>,
    @InjectRepository(Channel) private channels: Repository<Channel>,
    @InjectRepository(DailyPrice) private prices: Repository<DailyPrice>,
    @InjectRepository(DailyInventory) private inventory: Repository<DailyInventory>,
    @InjectRepository(Booking) private bookings: Repository<Booking>,
    @InjectRepository(CleaningTask) private cleaning: Repository<CleaningTask>,
    @InjectRepository(LinenItem) private linen: Repository<LinenItem>,
    @InjectRepository(LinenDelivery) private deliveries: Repository<LinenDelivery>,
    @InjectRepository(LinenBlock) private linenBlocks: Repository<LinenBlock>,
    @InjectRepository(MaintenanceTicket) private maintenance: Repository<MaintenanceTicket>,
    @InjectRepository(BreakfastPrep) private preps: Repository<BreakfastPrep>,
    @InjectRepository(Incident) private incidents: Repository<Incident>,
    @InjectRepository(Review) private reviews: Repository<Review>,
    @InjectRepository(Compensation) private compensations: Repository<Compensation>,
    private dataSource: DataSource,
  ) {}

  async onApplicationBootstrap() {
    if ((await this.users.count()) > 0) return;
    this.log.log('空库，写入国庆旺季演示数据...');
    await this.seed();
    this.log.log('种子数据完成');
  }

  private async seed() {
    const pwd = await bcrypt.hash('123456', 10);
    // 今日「布草堵车」现场相对服务启动锚定（30 分钟前堵在路上，预计 2.5 小时后到），任何时区打开都是进行中
    const now = new Date();
    const blockedSince = new Date(now.getTime() - 30 * 60000);
    const linenEta = new Date(now.getTime() + 150 * 60000);
    const [owner, steward, cleaner1, cleaner2, kitchen, front] = await this.users.save([
      { username: 'owner', passwordHash: pwd, name: '店主·陈山', role: 'owner' },
      { username: 'steward', passwordHash: pwd, name: '管家·小林', role: 'housekeeper' },
      { username: 'cleaner1', passwordHash: pwd, name: '保洁·王阿姨', role: 'cleaner' },
      { username: 'cleaner2', passwordHash: pwd, name: '保洁·李阿姨', role: 'cleaner' },
      { username: 'kitchen', passwordHash: pwd, name: '厨房·周师傅', role: 'kitchen' },
      { username: 'front', passwordHash: pwd, name: '前台·小赵', role: 'frontdesk' },
    ] as any);

    const [t1, t2, t3, t4] = await this.types.save([
      { code: 'T1', name: '山景大床房', basePrice: 688, maxAdults: 2, maxChildren: 1, extraBedAllowed: false, extraBedPrice: 0, petAllowed: false, petFee: 0, breakfastPrice: 38, depositAmount: 500 },
      { code: 'T2', name: '庭院双床房', basePrice: 588, maxAdults: 2, maxChildren: 1, extraBedAllowed: true, extraBedPrice: 80, petAllowed: true, petFee: 100, breakfastPrice: 38, depositAmount: 500 },
      { code: 'T3', name: '亲子家庭房', basePrice: 888, maxAdults: 3, maxChildren: 2, extraBedAllowed: true, extraBedPrice: 80, petAllowed: false, petFee: 0, breakfastPrice: 38, depositAmount: 800 },
      { code: 'T4', name: 'Loft观景套房', basePrice: 1288, maxAdults: 4, maxChildren: 2, extraBedAllowed: true, extraBedPrice: 100, petAllowed: true, petFee: 150, breakfastPrice: 38, depositAmount: 1000 },
    ] as any);

    const mkRooms = async (type: RoomType, codes: string[], floor: number) =>
      this.rooms.save(codes.map((code) => ({ code, floor, roomTypeId: type.id, status: 'clean' })) as any);
    const r1 = await mkRooms(t1, ['101', '102', '103'], 1);
    const r2 = await mkRooms(t2, ['201', '202', '203'], 2);
    const r3 = await mkRooms(t3, ['301', '302', '303'], 3);
    const r4 = await mkRooms(t4, ['401', '402', '403'], 4);
    const roomByCode = (c: string) => [...r1, ...r2, ...r3, ...r4].find((r) => r.code === c)!;

    const [web, miniapp, ota, phone] = await this.channels.save([
      { code: 'web', name: '官网', commissionRate: 0 },
      { code: 'miniapp', name: '小程序', commissionRate: 0.03 },
      { code: 'ota', name: 'OTA平台', commissionRate: 0.15 },
      { code: 'phone', name: '电话订房', commissionRate: 0 },
    ] as any);

    // 价格：国庆 10-01~10-07 旺季价 = 基准价 ×1.5，其余基准价
    const priceRows: Partial<DailyPrice>[] = [];
    for (const t of [t1, t2, t3, t4]) {
      for (const d of eachDay('2026-09-28', '2026-10-16')) {
        const peak = d >= '2026-10-01' && d <= '2026-10-07';
        priceRows.push({ roomTypeId: t.id, date: d, price: round2(Number(t.basePrice) * (peak ? 1.5 : 1)) });
      }
    }
    await this.prices.save(priceRows as any);

    // 库存：每房型每日 3 间
    const invRows: Partial<DailyInventory>[] = [];
    for (const t of [t1, t2, t3, t4]) {
      for (const d of eachDay('2026-09-28', '2026-10-16')) {
        invRows.push({ roomTypeId: t.id, date: d, total: 3, sellable: 3, booked: 0 });
      }
    }
    await this.inventory.save(invRows as any);

    // ---- 订单工厂 ----
    let seq = 1;
    const mkBooking = async (p: {
      room: string; channel: Channel; guest: string; phone?: string;
      in: string; out: string; adults: number; children?: number; extraBeds?: number;
      pets?: number; breakfast?: number; dietary?: string; invoice?: string; specialRequests?: string;
      status?: string; actualIn?: string; actualOut?: string; depositDeducted?: number;
    }) => {
      const room = roomByCode(p.room);
      const type = [t1, t2, t3, t4].find((t) => t.id === room.roomTypeId)!;
      const dates = eachDay(p.in, p.out);
      const nights = dates.length;
      let roomFee = 0;
      for (const d of dates) {
        const pr = await this.prices.findOne({ where: { roomTypeId: type.id, date: d } });
        roomFee += pr ? Number(pr.price) : Number(type.basePrice);
      }
      const extraBeds = p.extraBeds || 0;
      const breakfast = p.breakfast || 0;
      const extraBedFee = round2(extraBeds * nights * Number(type.extraBedPrice));
      const breakfastFee = round2(breakfast * nights * Number(type.breakfastPrice));
      const petFee = (p.pets || 0) > 0 ? Number(type.petFee) : 0;
      const status = p.status || 'booked';
      const depositDeducted = p.depositDeducted || 0;
      const b = await this.bookings.save(this.bookings.create({
        code: `BK26${String(seq++).padStart(4, '0')}`,
        channelId: p.channel.id, roomId: room.id, roomTypeId: type.id,
        guestName: p.guest, guestPhone: p.phone || '138****0000',
        checkIn: p.in, checkOut: p.out, nights,
        adults: p.adults, children: p.children || 0, extraBeds, pets: p.pets || 0,
        breakfastCount: breakfast, dietaryNotes: p.dietary || '',
        invoiceRequired: !!p.invoice, invoiceTitle: p.invoice || '',
        specialRequests: p.specialRequests || '',
        roomFee: round2(roomFee), extraBedFee, breakfastFee, petFee,
        totalAmount: round2(roomFee + extraBedFee + breakfastFee + petFee),
        depositAmount: Number(type.depositAmount), depositDeducted,
        depositReturned: status === 'checked_out' ? round2(Number(type.depositAmount) - depositDeducted) : 0,
        status,
        actualCheckIn: p.actualIn ? new Date(p.actualIn) : null,
        actualCheckOut: p.actualOut ? new Date(p.actualOut) : null,
      }));
      for (const d of dates) {
        await this.inventory.increment({ roomTypeId: type.id, date: d }, 'booked', 1);
      }
      return b;
    };

    // ---- 已退房订单 ----
    const bk1 = await mkBooking({ room: '101', channel: web, guest: '张先生', in: '2026-10-01', out: '2026-10-03', adults: 2, breakfast: 2, status: 'checked_out', actualIn: '2026-10-01T15:00:00+08:00', actualOut: '2026-10-03T11:30:00+08:00' });
    const bk2 = await mkBooking({ room: '201', channel: ota, guest: '刘女士', in: '2026-10-01', out: '2026-10-02', adults: 2, pets: 1, breakfast: 2, status: 'checked_out', actualIn: '2026-10-01T16:00:00+08:00', actualOut: '2026-10-02T14:30:00+08:00', depositDeducted: 300 });
    const bk3 = await mkBooking({ room: '301', channel: miniapp, guest: '王先生一家', in: '2026-10-01', out: '2026-10-03', adults: 2, children: 2, extraBeds: 1, breakfast: 4, dietary: '不吃辣', status: 'checked_out', actualIn: '2026-10-01T14:00:00+08:00', actualOut: '2026-10-03T12:10:00+08:00' });
    const bk4 = await mkBooking({ room: '401', channel: phone, guest: '周女士', in: '2026-10-01', out: '2026-10-02', adults: 4, breakfast: 4, status: 'checked_out', actualIn: '2026-10-01T15:30:00+08:00', actualOut: '2026-10-02T11:00:00+08:00' });
    // 10-01 庭院双床房超卖：3 间房 4 张单
    const bk17 = await mkBooking({ room: '203', channel: ota, guest: '黄先生', in: '2026-10-01', out: '2026-10-02', adults: 2, breakfast: 2, status: 'checked_out', actualIn: '2026-10-01T17:00:00+08:00', actualOut: '2026-10-02T10:30:00+08:00' });
    const bk18 = await mkBooking({ room: '203', channel: phone, guest: '吴女士', in: '2026-10-01', out: '2026-10-02', adults: 2, breakfast: 2, status: 'checked_out', actualIn: '2026-10-01T18:30:00+08:00', actualOut: '2026-10-02T10:00:00+08:00' });
    const bk19 = await mkBooking({ room: '202', channel: web, guest: '徐先生', in: '2026-10-01', out: '2026-10-02', adults: 2, breakfast: 2, status: 'checked_out', actualIn: '2026-10-01T15:00:00+08:00', actualOut: '2026-10-02T11:30:00+08:00' });

    // ---- 在住订单 ----
    const bk5 = await mkBooking({ room: '102', channel: web, guest: '李女士', in: '2026-10-02', out: '2026-10-05', adults: 2, breakfast: 2, invoice: '杭州云溪科技有限公司', status: 'checked_in', actualIn: '2026-10-02T15:00:00+08:00' });
    const bk6 = await mkBooking({ room: '202', channel: ota, guest: '赵先生', in: '2026-10-02', out: '2026-10-04', adults: 3, children: 1, breakfast: 4, dietary: '海鲜过敏', status: 'checked_in', actualIn: '2026-10-02T16:00:00+08:00' });
    const bk7 = await mkBooking({ room: '302', channel: miniapp, guest: '孙女士一家', in: '2026-10-03', out: '2026-10-06', adults: 2, children: 2, extraBeds: 1, breakfast: 4, dietary: '素食', status: 'checked_in', actualIn: '2026-10-03T14:30:00+08:00' });
    const bk8 = await mkBooking({ room: '402', channel: ota, guest: '钱先生', in: '2026-10-03', out: '2026-10-05', adults: 3, breakfast: 3, status: 'checked_in', actualIn: '2026-10-03T15:00:00+08:00' });
    const bk15 = await mkBooking({ room: '201', channel: web, guest: '郑先生', in: '2026-10-03', out: '2026-10-04', adults: 2, breakfast: 2, status: 'checked_in', actualIn: '2026-10-03T13:00:00+08:00' });
    const bk16 = await mkBooking({ room: '303', channel: ota, guest: '冯女士', in: '2026-10-02', out: '2026-10-04', adults: 2, children: 1, breakfast: 3, status: 'checked_in', actualIn: '2026-10-02T15:00:00+08:00' });

    // ---- 未来订单 ----
    const bk9 = await mkBooking({ room: '103', channel: web, guest: '许先生', in: '2026-10-04', out: '2026-10-06', adults: 2, breakfast: 2 });
    const bk10 = await mkBooking({ room: '203', channel: ota, guest: '何女士', in: '2026-10-04', out: '2026-10-07', adults: 2, pets: 1, breakfast: 2 });
    const bk11 = await mkBooking({ room: '301', channel: miniapp, guest: '吕先生一家', in: '2026-10-04', out: '2026-10-06', adults: 2, children: 1, breakfast: 3 });
    const bk12 = await mkBooking({ room: '403', channel: phone, guest: '孔女士', in: '2026-10-05', out: '2026-10-07', adults: 4, breakfast: 4, invoice: '上海远山设计工作室' });
    // 10-04 山景大床房超卖：102 住到 10-05、103 已订、101 被 OTA 连下两单
    const bk13 = await mkBooking({ room: '101', channel: ota, guest: '曹先生', in: '2026-10-04', out: '2026-10-05', adults: 2, breakfast: 2 });
    const bk14 = await mkBooking({ room: '101', channel: ota, guest: '谢女士', in: '2026-10-04', out: '2026-10-05', adults: 2, breakfast: 2 });
    // 10-03 今日到店：103 房上一轮客人刚退房、保洁刚做完，布草车却因山路堵车未到
    const bk20 = await mkBooking({ room: '103', channel: ota, guest: '沈女士一家', phone: '139****2077', in: '2026-10-03', out: '2026-10-04', adults: 2, children: 1, breakfast: 0, specialRequests: '到店较早，希望14点前入住' });

    // ---- 事件链 ----
    await this.incidents.save([
      { type: 'late_checkout', bookingId: bk2.id, roomId: bk2.roomId, description: `订单 ${bk2.code} 延迟退房 150 分钟（应 10-02 12:00 前退房），压缩当日保洁窗口`, status: 'resolved', cost: 0, occurredAt: new Date('2026-10-02T14:30:00+08:00'), resolvedAt: new Date('2026-10-02T15:00:00+08:00'), resolution: '保洁顺延，已通知下一单客人延迟入住' },
      { type: 'pet_damage', bookingId: bk2.id, roomId: bk2.roomId, description: `订单 ${bk2.code} 客人宠物抓坏床头柜与窗帘，维修估价 ¥300，已从押金扣除`, status: 'resolved', cost: 300, occurredAt: new Date('2026-10-02T14:40:00+08:00'), resolvedAt: new Date('2026-10-02T18:00:00+08:00'), resolution: '押金扣除 ¥300，家具已修' },
      { type: 'ac_failure', bookingId: bk3.id, roomId: bk3.roomId, description: '301 房空调制冷失效，客人夜间投诉，等待维修', status: 'open', cost: 0, occurredAt: new Date('2026-10-02T23:10:00+08:00') },
      { type: 'linen_delay', bookingId: null, roomId: null, description: '布草「床单」20 件延迟送达（应 10-02 09:00 前到，实际 16:20 到），当日保洁换布紧张', status: 'resolved', cost: 0, occurredAt: new Date('2026-10-02T16:20:00+08:00'), resolvedAt: new Date('2026-10-02T17:00:00+08:00'), resolution: '启用备用布草，洗涤厂承诺旺季每日两送' },
      { type: 'extra_guests', bookingId: bk6.id, roomId: bk6.roomId, description: `订单 ${bk6.code} 临时加人：成人 2→3，早餐 3→4 份/天，早餐费重算`, status: 'resolved', cost: 0, occurredAt: new Date('2026-10-02T20:00:00+08:00'), resolvedAt: new Date('2026-10-02T20:05:00+08:00'), resolution: '费用已重算' },
      { type: 'breakfast_shortage', bookingId: null, roomId: null, description: '2026-10-03 早餐供应不足：需求 15 份，实际备餐 12 份，缺口 3 份', status: 'resolved', cost: 50, occurredAt: new Date('2026-10-03T08:40:00+08:00'), resolvedAt: new Date('2026-10-03T09:30:00+08:00'), resolution: '向受影响客人补偿并加急补做' },
      { type: 'oversell', bookingId: bk18.id, roomId: bk18.roomId, description: `10-01「庭院双床房」超售：电话与 OTA 同时订出 203，物理房量不足，吴女士到店无房等待 2 小时`, status: 'resolved', cost: 200, occurredAt: new Date('2026-10-01T18:30:00+08:00'), resolvedAt: new Date('2026-10-01T20:40:00+08:00'), resolution: '协调同房型升级并免单 ¥200' },
      { type: 'oversell', bookingId: bk14.id, roomId: bk14.roomId, description: `10-04「山景大床房」超售：OTA 连续下单致 101 重复售出（已订 4/物理 3），需提前协调`, status: 'open', cost: 0, occurredAt: new Date('2026-10-03T09:20:00+08:00') },
    ] as any);

    // ---- 维修 ----
    await this.maintenance.save([
      { roomId: bk3.roomId, bookingId: bk3.id, type: 'ac', description: '空调故障：301 制冷失效，疑似压缩机问题', status: 'open', cost: 0, reportedAt: new Date('2026-10-02T23:15:00+08:00') },
      { roomId: bk2.roomId, bookingId: bk2.id, type: 'furniture', description: '宠物损坏：床头柜抓痕、窗帘撕破', status: 'fixed', cost: 300, reportedAt: new Date('2026-10-02T14:45:00+08:00'), fixedAt: new Date('2026-10-02T18:00:00+08:00') },
    ] as any);
    await this.rooms.update(bk3.roomId, { status: 'maintenance' });

    // ---- 保洁任务 ----
    await this.cleaning.save([
      { roomId: bk1.roomId, bookingId: bk1.id, date: '2026-10-03', dirtiness: 'normal', status: 'inspected', assigneeId: cleaner1.id, scheduledStart: new Date('2026-10-03T09:00:00+08:00'), startedAt: new Date('2026-10-03T09:05:00+08:00'), finishedAt: new Date('2026-10-03T09:50:00+08:00'), linenUsed: 1 },
      { roomId: bk2.roomId, bookingId: bk2.id, date: '2026-10-02', dirtiness: 'heavy', status: 'inspected', assigneeId: cleaner2.id, scheduledStart: new Date('2026-10-02T15:00:00+08:00'), startedAt: new Date('2026-10-02T15:10:00+08:00'), finishedAt: new Date('2026-10-02T16:20:00+08:00'), linenUsed: 2 },
      { roomId: bk3.roomId, bookingId: bk3.id, date: '2026-10-03', dirtiness: 'heavy', status: 'pending', linenUsed: 0 },
      { roomId: bk4.roomId, bookingId: bk4.id, date: '2026-10-02', dirtiness: 'light', status: 'inspected', assigneeId: cleaner1.id, scheduledStart: new Date('2026-10-02T11:30:00+08:00'), startedAt: new Date('2026-10-02T11:35:00+08:00'), finishedAt: new Date('2026-10-02T12:05:00+08:00'), linenUsed: 1 },
      { roomId: bk17.roomId, bookingId: bk17.id, date: '2026-10-02', dirtiness: 'normal', status: 'done', assigneeId: cleaner2.id, scheduledStart: new Date('2026-10-02T13:00:00+08:00'), startedAt: new Date('2026-10-02T13:00:00+08:00'), finishedAt: new Date('2026-10-02T13:45:00+08:00'), linenUsed: 1 },
      // 103 房今日打扫已完成，但布草车堵车未到，无法换布验收交付
      { roomId: bk20.roomId, bookingId: null, date: '2026-10-03', dirtiness: 'normal', status: 'done', assigneeId: cleaner1.id, scheduledStart: new Date(blockedSince.getTime() - 40 * 60000), startedAt: new Date(blockedSince.getTime() - 35 * 60000), finishedAt: blockedSince, linenUsed: 1, notes: '打扫完成，等布草车送床单' },
    ] as any);
    await this.rooms.update(bk1.roomId, { status: 'inspected' });
    await this.rooms.update(bk2.roomId, { status: 'inspected' });
    await this.rooms.update(bk4.roomId, { status: 'inspected' });
    await this.rooms.update(bk17.roomId, { status: 'clean' });
    await this.rooms.update(bk20.roomId, { status: 'awaiting_linen' });

    // ---- 布草 ----
    await this.linen.save([
      { item: '床单', total: 60, inUse: 18, inWash: 10, damaged: 2, safetyStock: 8 },
      { item: '被套', total: 60, inUse: 18, inWash: 10, damaged: 1, safetyStock: 8 },
      { item: '毛巾', total: 120, inUse: 40, inWash: 16, damaged: 4, safetyStock: 15 },
      { item: '枕套', total: 80, inUse: 24, inWash: 8, damaged: 2, safetyStock: 10 },
    ] as any);
    await this.deliveries.save(this.deliveries.create({
      item: '床单', quantity: 20, expectedAt: new Date('2026-10-02T09:00:00+08:00'),
      arrivedAt: new Date('2026-10-02T16:20:00+08:00'), status: 'delayed',
      reason: '山路堵车', supplier: '山外洁净洗涤厂',
    }));
    await this.deliveries.save(this.deliveries.create({
      item: '毛巾', quantity: 30, expectedAt: new Date('2026-10-03T09:30:00+08:00'),
      arrivedAt: new Date('2026-10-03T12:40:00+08:00'), status: 'delayed',
      reason: '上午山路临时交通管制', supplier: '山外洁净洗涤厂',
    }));
    await this.deliveries.save(this.deliveries.create({
      item: '被套', quantity: 20, expectedAt: new Date('2026-10-01T09:00:00+08:00'),
      arrivedAt: new Date('2026-10-01T08:40:00+08:00'), status: 'delivered',
      supplier: '山外洁净洗涤厂',
    }));
    // 今日下午布草车仍堵在路上：103 房保洁已完成，等这一单布草交付
    const dlToday = await this.deliveries.save(this.deliveries.create({
      item: '床单', quantity: 12, expectedAt: linenEta,
      status: 'scheduled', reason: '午后山路堵车，布草车晚点', supplier: '山外洁净洗涤厂',
    }));
    await this.deliveries.save(this.deliveries.create({
      item: '毛巾', quantity: 30, expectedAt: new Date('2026-10-04T10:00:00+08:00'),
      status: 'scheduled', supplier: '山外洁净洗涤厂',
    }));

    // ---- 早餐备餐 ----
    await this.preps.save([
      { date: '2026-10-02', requiredPortions: 12, preparedPortions: 12, status: 'confirmed', confirmedAt: new Date('2026-10-01T20:00:00+08:00') },
      { date: '2026-10-03', requiredPortions: 15, preparedPortions: 12, status: 'shortage', confirmedAt: new Date('2026-10-02T20:00:00+08:00'), note: '低估了临时加人，10-04 起按上限备餐' },
    ] as any);

    // ---- 差评与补偿 ----
    const rv1 = await this.reviews.save(this.reviews.create({ bookingId: bk3.id, rating: 2, category: 'hardware', content: '半夜空调坏了，孩子热醒两次，维修一直没来', compensated: true, createdAt: new Date('2026-10-03T13:00:00+08:00') }));
    const rv2 = await this.reviews.save(this.reviews.create({ bookingId: bk16.id, rating: 3, category: 'food', content: '八点半下去早餐就没剩什么了，孩子没吃饱', compensated: true, createdAt: new Date('2026-10-03T10:30:00+08:00') }));
    const rv3 = await this.reviews.save(this.reviews.create({ bookingId: bk18.id, rating: 2, category: 'oversell', content: '到店说没房，拖着行李等了两个多小时才安排', compensated: false, createdAt: new Date('2026-10-02T12:00:00+08:00') }));
    const rv4 = await this.reviews.save(this.reviews.create({ bookingId: bk4.id, rating: 5, category: 'service', content: '管家很贴心，帮忙安排了儿童餐和加床', compensated: false, createdAt: new Date('2026-10-02T15:00:00+08:00') }));
    const rv5 = await this.reviews.save(this.reviews.create({ bookingId: bk2.id, rating: 3, category: 'service', content: '退房后押金隔了一天才退，希望加快', compensated: false, createdAt: new Date('2026-10-03T09:00:00+08:00') }));

    await this.incidents.save([
      { type: 'bad_review', bookingId: bk3.id, roomId: bk3.roomId, description: '差评（2分/hardware）：半夜空调坏了，孩子热醒两次', status: 'resolved', cost: 100, occurredAt: new Date('2026-10-03T13:00:00+08:00'), resolvedAt: new Date('2026-10-03T14:00:00+08:00'), resolution: '已补偿 补偿券 VC7K2Q9P ¥100' },
      { type: 'bad_review', bookingId: bk16.id, roomId: bk16.roomId, description: '差评（3分/food）：早餐八点半就没东西了', status: 'resolved', cost: 50, occurredAt: new Date('2026-10-03T10:30:00+08:00'), resolvedAt: new Date('2026-10-03T11:00:00+08:00'), resolution: '已补偿现金 ¥50' },
      { type: 'bad_review', bookingId: bk18.id, roomId: bk18.roomId, description: '差评（2分/oversell）：到店没房等了两小时', status: 'open', cost: 0, occurredAt: new Date('2026-10-02T12:00:00+08:00') },
      { type: 'bad_review', bookingId: bk2.id, roomId: bk2.roomId, description: '差评（3分/service）：押金退回慢', status: 'open', cost: 0, occurredAt: new Date('2026-10-03T09:00:00+08:00') },
    ] as any);

    await this.compensations.save([
      { reviewId: rv1.id, bookingId: bk3.id, type: 'voucher', amount: 100, voucherCode: 'VC7K2Q9P', status: 'issued', reason: '空调故障差评补偿', createdAt: new Date('2026-10-03T14:00:00+08:00') },
      { reviewId: rv2.id, bookingId: bk16.id, type: 'cash', amount: 50, voucherCode: null, status: 'issued', reason: '早餐不足差评补偿', createdAt: new Date('2026-10-03T11:00:00+08:00') },
    ] as any);

    // ---- 今日布草堵车：103 房待布草，沈女士一家无法按时入住 ----
    const linenIncident = await this.incidents.save(this.incidents.create({
      type: 'linen_delay', bookingId: bk20.id, roomId: bk20.roomId,
      description: '布草车山路堵车未到，103 房保洁已完成但缺「床单」1 套，'
        + `预计 ${linenEta.toLocaleString('zh-CN')} 到达，沈女士一家提前到店约等待 150 分钟，房间暂无法交付；可调拨房间 101`,
      status: 'open', cost: 0, occurredAt: blockedSince,
    }));
    const block = await this.linenBlocks.save(this.linenBlocks.create({
      roomId: bk20.roomId, bookingId: bk20.id, deliveryId: dlToday.id, incidentId: linenIncident.id,
      item: '床单', shortage: 1,
      expectedAt: linenEta,
      blockedSince,
      status: 'active', waitMinutes: 150, transferRoomIds: String(roomByCode('101').id),
      note: '管家已在大堂接待，先安排下午茶；如布草持续不到则换房 101',
    }));
    await this.compensations.save(this.compensations.create({
      linenBlockId: block.id, bookingId: bk20.id, incidentId: linenIncident.id,
      type: 'afternoon_tea', amount: 68, status: 'issued',
      reason: '布草延迟待客·下午茶（沈女士一家 3 位）',
      createdAt: new Date(blockedSince.getTime() + 10 * 60000),
    }));
  }
}

@Module({
  imports: [TypeOrmModule.forFeature(ALL_ENTITIES)],
  providers: [SeedService],
})
export class SeedModule {}
