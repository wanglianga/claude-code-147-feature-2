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
  // 保洁状态：clean 已清洁 | dirty 待打扫 | cleaning 打扫中 | inspected 已验收 | maintenance 维修中 | awaiting_linen 待布草
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
}

@Entity('linen_deliveries')
export class LinenDelivery {
  @PrimaryGeneratedColumn() id: number;
  @Column() item: string;
  @Column() quantity: number;
  @Column({ type: 'timestamptz' }) expectedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) arrivedAt: Date;
  @Column({ default: 'scheduled' }) status: string; // scheduled | delivered | delayed
  @CreateDateColumn() createdAt: Date;
}

// ---------- 布草缺口（保洁完成但布草未到，房间待布草无法交付） ----------
@Entity('linen_shortages')
export class LinenShortage {
  @PrimaryGeneratedColumn() id: number;
  @Column() roomId: number;
  @ManyToOne(() => Room) @JoinColumn({ name: 'roomId' }) room: Room;
  @Column({ nullable: true }) bookingId: number;  // 等待入住的订单
  @Column({ nullable: true }) deliveryId: number; // 关联的送洗配送单
  @Column() item: string;                          // 缺口布草（床单/被套…）
  @Column({ default: 1 }) quantity: number;        // 缺口套数
  @Column({ type: 'timestamptz' }) expectedAt: Date;                 // 布草预计到达
  @Column({ type: 'timestamptz', default: () => 'now()' }) waitingSince: Date; // 客人开始等待
  @Column({ type: 'timestamptz', nullable: true }) resolvedAt: Date;
  // waiting 等待中 | resolved 布草到达已恢复 | relocated 客人已调拨换房
  @Column({ default: 'waiting' }) status: string;
  @Column({ default: '' }) resolution: string;
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
  @Column() type: string; // cash 现金 | voucher 补偿券 | refund 退款
  @Money() amount: number;
  @Column({ nullable: true }) voucherCode: string;
  @Column({ default: 'issued' }) status: string; // issued | used | cancelled
  @Column({ default: '' }) reason: string;
  @CreateDateColumn() createdAt: Date;
}

export const ALL_ENTITIES = [
  User, RoomType, Room, Channel, DailyPrice, DailyInventory, Booking,
  CleaningTask, LinenItem, LinenDelivery, LinenShortage, MaintenanceTicket, BreakfastPrep,
  Incident, Review, Compensation,
];
