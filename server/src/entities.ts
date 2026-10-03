import {
  Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique,
} from 'typeorm';

const numTransformer = {
  to: (v: any) => v,
  from: (v: any) => (v === null || v === undefined ? null : Number(v)),
};
const Money = (opts: any = {}) =>
  Column({ type: 'numeric', precision: 12, scale: 2, default: 0, transformer: numTransformer, ...opts });

// ---------- 用户 ----------
@Entity('users')
export class User {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) username: string;
  @Column() passwordHash: string;
  @Column() name: string;
  @Column() role: string; // owner 店主 | housekeeper 管家 | cleaner 保洁 | kitchen 厨房 | frontdesk 前台
  @CreateDateColumn() createdAt: Date;
}

// ---------- 房型 / 房间 / 渠道 ----------
@Entity('room_types')
export class RoomType {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string;
  @Column() name: string;
  @Money() basePrice: number;
  @Column({ default: 2 }) maxAdults: number;
  @Column({ default: 1 }) maxChildren: number;
  @Column({ default: false }) extraBedAllowed: boolean;
  @Money() extraBedPrice: number;
  @Column({ default: false }) petAllowed: boolean;
  @Money() petFee: number; // 宠物清洁费（一次性）
  @Money() breakfastPrice: number; // 早餐单价/份/天
  @Money() depositAmount: number; // 押金
}

@Entity('rooms')
export class Room {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string;
  @Column({ default: 1 }) floor: number;
  // clean 已清洁 | dirty 待打扫 | cleaning 打扫中 | inspected 已验收 | maintenance 维修中
  // awaiting_linen 待布草：保洁已完成但布草未到，无法交付入住
  @Column({ default: 'clean' }) status: string;
  @Column() roomTypeId: number;
  @ManyToOne(() => RoomType) @JoinColumn({ name: 'roomTypeId' }) roomType: RoomType;
}

@Entity('channels')
export class Channel {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string; // web | miniapp | ota | phone
  @Column() name: string;
  @Column({ type: 'numeric', precision: 5, scale: 4, default: 0, transformer: numTransformer })
  commissionRate: number; // 渠道佣金比例
}

// ---------- 价格与库存 ----------
@Entity('daily_prices')
@Unique(['roomTypeId', 'date'])
export class DailyPrice {
  @PrimaryGeneratedColumn() id: number;
  @Column() roomTypeId: number;
  @Column({ type: 'date' }) date: string;
  @Money() price: number;
}

@Entity('daily_inventory')
@Unique(['roomTypeId', 'date'])
export class DailyInventory {
  @PrimaryGeneratedColumn() id: number;
  @Column() roomTypeId: number;
  @Column({ type: 'date' }) date: string;
  @Column({ default: 0 }) total: number;    // 物理房量
  @Column({ default: 0 }) sellable: number; // 系统调整后的可售房量
  @Column({ default: 0 }) booked: number;   // 已订
}

// ---------- 订单 ----------
@Entity('bookings')
export class Booking {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string;
  @Column() channelId: number;
  @ManyToOne(() => Channel) @JoinColumn({ name: 'channelId' }) channel: Channel;
  @Column() roomId: number;
  @ManyToOne(() => Room) @JoinColumn({ name: 'roomId' }) room: Room;
  @Column() roomTypeId: number;
  @ManyToOne(() => RoomType) @JoinColumn({ name: 'roomTypeId' }) roomType: RoomType;

  @Column() guestName: string;
  @Column({ default: '' }) guestPhone: string;
  @Column({ type: 'date' }) checkIn: string;
  @Column({ type: 'date' }) checkOut: string;
  @Column() nights: number;
  @Column({ default: 2 }) adults: number;
  @Column({ default: 0 }) children: number;
  @Column({ default: 0 }) extraBeds: number;
  @Column({ default: 0 }) pets: number;
  @Column({ default: 0 }) breakfastCount: number; // 每日早餐份数
  @Column({ default: '' }) dietaryNotes: string;  // 忌口
  @Column({ default: false }) invoiceRequired: boolean;
  @Column({ default: '' }) invoiceTitle: string;
  @Column({ default: '' }) specialRequests: string;

  @Money() roomFee: number;
  @Money() extraBedFee: number;
  @Money() breakfastFee: number;
  @Money() petFee: number;
  @Money() totalAmount: number;
  @Money() depositAmount: number;
  @Money() depositDeducted: number; // 押金扣款（如宠物损坏）
  @Money() depositReturned: number;

  // booked | checked_in | checked_out | cancelled
  @Column({ default: 'booked' }) status: string;
  @Column({ type: 'timestamptz', nullable: true }) actualCheckIn: Date;
  @Column({ type: 'timestamptz', nullable: true }) actualCheckOut: Date;
  @CreateDateColumn() createdAt: Date;
}

// ---------- 保洁 ----------
@Entity('cleaning_tasks')
export class CleaningTask {
  @PrimaryGeneratedColumn() id: number;
  @Column() roomId: number;
  @ManyToOne(() => Room) @JoinColumn({ name: 'roomId' }) room: Room;
  @Column({ nullable: true }) bookingId: number;
  @Column({ type: 'date' }) date: string;
  @Column({ default: 'normal' }) dirtiness: string; // light | normal | heavy
  // pending | assigned | in_progress | done | inspected
  @Column({ default: 'pending' }) status: string;
  @Column({ nullable: true }) assigneeId: number;
  @ManyToOne(() => User, { nullable: true }) @JoinColumn({ name: 'assigneeId' }) assignee: User;
  @Column({ type: 'timestamptz', nullable: true }) scheduledStart: Date;
  @Column({ type: 'timestamptz', nullable: true }) startedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) finishedAt: Date;
  @Column({ default: 0 }) linenUsed: number; // 更换布草套数
  @Column({ default: 0 }) priority: number;
  @Column({ default: '' }) notes: string;
}

// ---------- 布草 ----------
@Entity('linen_items')
export class LinenItem {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) item: string; // 床单/被套/毛巾/枕套
  @Column({ default: 0 }) total: number;
  @Column({ default: 0 }) inUse: number;
  @Column({ default: 0 }) inWash: number;
  @Column({ default: 0 }) damaged: number;
  @Column({ default: 0 }) safetyStock: number; // 安全库存（多次延迟后平台建议上调）
}

@Entity('linen_deliveries')
export class LinenDelivery {
  @PrimaryGeneratedColumn() id: number;
  @Column() item: string;
  @Column() quantity: number;
  @Column({ type: 'timestamptz' }) expectedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) arrivedAt: Date;
  @Column({ default: 'scheduled' }) status: string; // scheduled | delivered | delayed
  @Column({ default: '' }) reason: string; // 延迟原因（山路堵车/洗涤厂积压…）
  @Column({ default: '' }) supplier: string; // 洗涤供应商
  @CreateDateColumn() createdAt: Date;
}

// 布草缺口阻塞：保洁完成但布草车未到，房间无法按时交付
@Entity('linen_blocks')
export class LinenBlock {
  @PrimaryGeneratedColumn() id: number;
  @Column() roomId: number;
  @ManyToOne(() => Room) @JoinColumn({ name: 'roomId' }) room: Room;
  @Column({ nullable: true }) bookingId: number; // 等待入住的订单
  @Column({ nullable: true }) deliveryId: number; // 关联配送单（到达后自动恢复）
  @Column({ nullable: true }) incidentId: number; // 关联布草延迟事件
  @Column({ default: '' }) item: string;      // 缺口布草（空=整套）
  @Column({ default: 1 }) shortage: number;   // 缺口套数
  @Column({ type: 'timestamptz' }) expectedAt: Date;  // 布草预计到达
  @Column({ type: 'timestamptz' }) blockedSince: Date; // 进入待布草的时间
  @Column({ type: 'timestamptz', nullable: true }) resolvedAt: Date;
  // active 待布草 | resolved 布草到达已恢复 | reassigned 已为客人换房
  @Column({ default: 'active' }) status: string;
  @Column({ default: 0 }) waitMinutes: number; // 客人等待时长（登记时估算/解决时实际）
  @Column({ default: '' }) transferRoomIds: string; // 可调拨房间 id 列表，逗号分隔
  @Column({ default: '' }) note: string;
  @CreateDateColumn() createdAt: Date;
}

// 平台针对重复布草延迟的处置动作记录（安全库存/供应商/高峰限制）
@Entity('linen_actions')
export class LinenAction {
  @PrimaryGeneratedColumn() id: number;
  // safety_stock 增加安全库存 | supplier 调整洗涤供应商 | peak_limit 限制高峰连住订单
  @Column() type: string;
  @Column({ type: 'text' }) detail: string;
  @CreateDateColumn() createdAt: Date;
}

// ---------- 维修 ----------
@Entity('maintenance_tickets')
export class MaintenanceTicket {
  @PrimaryGeneratedColumn() id: number;
  @Column() roomId: number;
  @ManyToOne(() => Room) @JoinColumn({ name: 'roomId' }) room: Room;
  @Column({ nullable: true }) bookingId: number;
  @Column() type: string; // ac | plumbing | furniture | appliance | other
  @Column() description: string;
  @Column({ default: 'open' }) status: string; // open | fixing | fixed
  @Money() cost: number;
  @CreateDateColumn() reportedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) fixedAt: Date;
}

// ---------- 早餐 ----------
@Entity('breakfast_preps')
export class BreakfastPrep {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'date', unique: true }) date: string;
  @Column({ default: 0 }) requiredPortions: number;
  @Column({ default: 0 }) preparedPortions: number;
  @Column({ default: 'planned' }) status: string; // planned | confirmed | shortage
  @Column({ default: '' }) note: string;
  @Column({ type: 'timestamptz', nullable: true }) confirmedAt: Date;
}

// ---------- 事件（住宿链路） ----------
@Entity('incidents')
export class Incident {
  @PrimaryGeneratedColumn() id: number;
  // late_checkout 延迟退房 | ac_failure 空调故障 | linen_delay 布草延迟 | extra_guests 临时加人
  // pet_damage 宠物损坏 | breakfast_shortage 早餐不足 | oversell 渠道超卖 | bad_review 差评 | other
  @Column() @Index() type: string;
  @Column({ nullable: true }) @Index() bookingId: number;
  @Column({ nullable: true }) roomId: number;
  @Column({ type: 'text' }) description: string;
  @Column({ default: 'open' }) status: string; // open | processing | resolved
  @Money() cost: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) occurredAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) resolvedAt: Date;
  @Column({ default: '' }) resolution: string;
}

// ---------- 差评与补偿 ----------
@Entity('reviews')
export class Review {
  @PrimaryGeneratedColumn() id: number;
  @Column() bookingId: number;
  @ManyToOne(() => Booking) @JoinColumn({ name: 'bookingId' }) booking: Booking;
  @Column() rating: number; // 1-5，<=3 为差评
  @Column() category: string; // hardware 硬件 | service 服务 | oversell 超卖 | food 餐食
  @Column({ type: 'text' }) content: string;
  @Column({ default: false }) compensated: boolean;
  @CreateDateColumn() createdAt: Date;
}

@Entity('compensations')
export class Compensation {
  @PrimaryGeneratedColumn() id: number;
  @Column({ nullable: true }) reviewId: number;
  @Column({ nullable: true }) incidentId: number;
  @Column({ nullable: true }) bookingId: number;
  @Column({ nullable: true }) linenBlockId: number; // 布草延迟待客补偿
  // cash 现金 | voucher 补偿券 | refund 退款
  // afternoon_tea 下午茶 | room_change 换房 | late_checkin 延迟入住补偿
  @Column() type: string;
  @Money() amount: number;
  @Column({ nullable: true }) voucherCode: string;
  @Column({ default: 'issued' }) status: string; // issued | used | cancelled
  @Column({ default: '' }) reason: string;
  @CreateDateColumn() createdAt: Date;
}

export const ALL_ENTITIES = [
  User, RoomType, Room, Channel, DailyPrice, DailyInventory, Booking,
  CleaningTask, LinenItem, LinenDelivery, LinenBlock, LinenAction,
  MaintenanceTicket, BreakfastPrep, Incident, Review, Compensation,
];
