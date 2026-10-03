import {
  BadRequestException, Body, ConflictException, Controller, Get, Module,
  NotFoundException, Param, Post, Query,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  Booking, Channel, CleaningTask, Compensation, DailyInventory, DailyPrice,
  Incident, Review, Room,
} from '../entities';
import { computeSettlement } from '../common/settlement';
import { CurrentUser } from '../common/auth';
import { diffDays, eachDay, round2, todayStr } from '../common/util';

class CreateBookingDto {
  roomId: number;
  channelId: number;
  guestName: string;
  guestPhone?: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children?: number;
  extraBeds?: number;
  pets?: number;
  breakfastCount?: number;
  dietaryNotes?: string;
  invoiceRequired?: boolean;
  invoiceTitle?: string;
  specialRequests?: string;
  force?: boolean; // OTA 强推/店主强制下单，允许突破可售（可能触发超卖事件）
}

@Controller('bookings')
export class BookingsController {
  constructor(
    @InjectRepository(Booking) private bookings: Repository<Booking>,
    @InjectRepository(Room) private rooms: Repository<Room>,
    @InjectRepository(Channel) private channels: Repository<Channel>,
    @InjectRepository(DailyInventory) private inventory: Repository<DailyInventory>,
    @InjectRepository(DailyPrice) private prices: Repository<DailyPrice>,
    @InjectRepository(CleaningTask) private cleaning: Repository<CleaningTask>,
    @InjectRepository(Incident) private incidents: Repository<Incident>,
    @InjectRepository(Review) private reviews: Repository<Review>,
    @InjectRepository(Compensation) private compensations: Repository<Compensation>,
    private dataSource: DataSource,
  ) {}

  @Get()
  async list(@Query('status') status?: string, @Query('channelId') channelId?: number,
             @Query('date') date?: string) {
    const qb = this.bookings.createQueryBuilder('b')
      .leftJoinAndSelect('b.channel', 'channel')
      .leftJoinAndSelect('b.room', 'room')
      .leftJoinAndSelect('b.roomType', 'roomType')
      .orderBy('b.checkIn', 'DESC').addOrderBy('b.id', 'DESC');
    if (status) qb.andWhere('b.status = :status', { status });
    if (channelId) qb.andWhere('b.channelId = :channelId', { channelId });
    if (date) qb.andWhere('b.checkIn <= :date AND b.checkOut > :date', { date });
    return qb.getMany();
  }

  @Post()
  async create(@Body() dto: CreateBookingDto, @CurrentUser() user: any) {
    const room = await this.rooms.findOne({ where: { id: dto.roomId }, relations: ['roomType'] });
    if (!room) throw new NotFoundException('房间不存在');
    const channel = await this.channels.findOne({ where: { id: dto.channelId } });
    if (!channel) throw new NotFoundException('渠道不存在');
    const type = room.roomType;
    const nights = diffDays(dto.checkIn, dto.checkOut);
    if (nights <= 0) throw new BadRequestException('离店日期必须晚于入住日期');

    // 统一规则校验：宠物 / 加床 / 人数
    const pets = dto.pets || 0;
    const extraBeds = dto.extraBeds || 0;
    if (pets > 0 && !type.petAllowed) throw new BadRequestException(`「${type.name}」不允许携带宠物`);
    if (extraBeds > 0 && !type.extraBedAllowed) throw new BadRequestException(`「${type.name}」不可加床`);
    if (dto.adults > type.maxAdults + extraBeds) {
      throw new BadRequestException(`入住成人超过上限（${type.maxAdults}人+${type.extraBedAllowed ? '加床' : '不可加床'}）`);
    }
    if ((dto.children || 0) > type.maxChildren) {
      throw new BadRequestException(`儿童数超过上限（${type.maxChildren}人）`);
    }

    const dates = eachDay(dto.checkIn, dto.checkOut);
    const result = await this.dataSource.transaction(async (em) => {
      // 库存校验与占用
      const oversoldDates: string[] = [];
      for (const d of dates) {
        let inv = await em.findOne(DailyInventory, { where: { roomTypeId: type.id, date: d } });
        if (!inv) {
          const total = await em.count(Room, { where: { roomTypeId: type.id } });
          inv = await em.save(em.create(DailyInventory, { roomTypeId: type.id, date: d, total, sellable: total, booked: 0 }));
        }
        if (inv.booked >= inv.sellable) {
          const canForce = dto.force && (channel.code === 'ota' || user?.role === 'owner');
          if (!canForce) throw new ConflictException(`${d} 库存不足（可售${inv.sellable}/已订${inv.booked}）`);
        }
        inv.booked += 1;
        await em.save(inv);
        if (inv.booked > inv.total) oversoldDates.push(d);
      }
      // 价格与费用
      let roomFee = 0;
      for (const d of dates) {
        const p = await em.findOne(DailyPrice, { where: { roomTypeId: type.id, date: d } });
        roomFee += p ? Number(p.price) : Number(type.basePrice);
      }
      const breakfastCount = dto.breakfastCount || 0;
      const extraBedFee = round2(extraBeds * nights * Number(type.extraBedPrice));
      const breakfastFee = round2(breakfastCount * nights * Number(type.breakfastPrice));
      const petFee = pets > 0 ? Number(type.petFee) : 0;
      const totalAmount = round2(roomFee + extraBedFee + breakfastFee + petFee);
      const code = 'BK' + dto.checkIn.replace(/-/g, '').slice(2) + String(Date.now()).slice(-6);
      const booking = await em.save(em.create(Booking, {
        code, channelId: channel.id, roomId: room.id, roomTypeId: type.id,
        guestName: dto.guestName, guestPhone: dto.guestPhone || '',
        checkIn: dto.checkIn, checkOut: dto.checkOut, nights,
        adults: dto.adults, children: dto.children || 0, extraBeds, pets,
        breakfastCount, dietaryNotes: dto.dietaryNotes || '',
        invoiceRequired: !!dto.invoiceRequired, invoiceTitle: dto.invoiceTitle || '',
        specialRequests: dto.specialRequests || '',
        roomFee: round2(roomFee), extraBedFee, breakfastFee, petFee, totalAmount,
        depositAmount: Number(type.depositAmount), depositDeducted: 0, depositReturned: 0,
        status: 'booked',
      }));
      // 超卖事件：已订超过物理房量
      if (oversoldDates.length) {
        await em.save(em.create(Incident, {
          type: 'oversell', bookingId: booking.id, roomId: room.id,
          description: `渠道「${channel.name}」订单 ${code} 导致「${type.name}」${oversoldDates.join('、')} 超售（物理房量不足）`,
          status: 'open', cost: 0,
        }));
      }
      return booking;
    });
    return this.detail(result.id);
  }

  @Get(':id')
  detail(@Param('id') id: number) {
    return this.buildDetail(id);
  }

  private async buildDetail(id: number) {
    const booking = await this.bookings.findOne({
      where: { id }, relations: ['channel', 'room', 'roomType'],
    });
    if (!booking) throw new NotFoundException('订单不存在');
    const [incidents, review, compensations, cleaningTask] = await Promise.all([
      this.incidents.find({ where: { bookingId: id }, order: { occurredAt: 'ASC' } }),
      this.reviews.findOne({ where: { bookingId: id } }),
      this.compensations.find({ where: { bookingId: id } }),
      this.cleaning.findOne({ where: { bookingId: id }, relations: ['assignee'] }),
    ]);
    return { ...booking, incidents, review, compensations, cleaningTask, settlement: computeSettlement(booking, compensations) };
  }

  @Post(':id/check-in')
  async checkIn(@Param('id') id: number) {
    const b = await this.bookings.findOne({ where: { id }, relations: ['room'] });
    if (!b) throw new NotFoundException('订单不存在');
    if (b.status !== 'booked') throw new BadRequestException('仅待入住订单可办理入住');
    if ((b.room as any).status === 'awaiting_linen') {
      throw new ConflictException(`布草车尚未到达，${b.room.code} 房为「待布草」状态无法交付。可请客人稍候、安排下午茶，或在保洁与布草页为客人换房`);
    }
    if (['dirty', 'cleaning', 'maintenance'].includes((b.room as any).status)) {
      throw new ConflictException(`${b.room.code} 房当前为「${(b.room as any).status}」，尚未完成保洁/维修，暂不能入住`);
    }
    b.status = 'checked_in';
    b.actualCheckIn = new Date();
    return this.bookings.save(b);
  }

  // 退房：生成保洁任务；晚于 12:30 记延迟退房事件
  @Post(':id/check-out')
  async checkOut(@Param('id') id: number, @Body() body: { actualTime?: string; dirtiness?: string }) {
    const b = await this.bookings.findOne({ where: { id }, relations: ['room'] });
    if (!b) throw new NotFoundException('订单不存在');
    if (b.status !== 'checked_in') throw new BadRequestException('仅在住订单可办理退房');
    const actual = body.actualTime ? new Date(body.actualTime) : new Date();
    const expected = new Date(b.checkOut + 'T12:00:00+08:00');
    await this.dataSource.transaction(async (em) => {
      b.status = 'checked_out';
      b.actualCheckOut = actual;
      b.depositReturned = round2(Number(b.depositAmount) - Number(b.depositDeducted));
      await em.save(b);
      await em.update(Room, b.roomId, { status: 'dirty' });
      await em.save(em.create(CleaningTask, {
        roomId: b.roomId, bookingId: b.id, date: todayStr(),
        dirtiness: body.dirtiness || 'normal', status: 'pending',
      }));
      if (actual.getTime() > expected.getTime() + 30 * 60000) {
        const mins = Math.round((actual.getTime() - expected.getTime()) / 60000);
        await em.save(em.create(Incident, {
          type: 'late_checkout', bookingId: b.id, roomId: b.roomId,
          description: `订单 ${b.code} 延迟退房 ${mins} 分钟（应 ${b.checkOut} 12:00 前退房），影响后续排房与保洁`,
          status: 'open', cost: 0,
        }));
      }
    });
    return this.buildDetail(id);
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: number) {
    const b = await this.bookings.findOne({ where: { id } });
    if (!b) throw new NotFoundException('订单不存在');
    if (b.status !== 'booked') throw new BadRequestException('仅待入住订单可取消');
    await this.dataSource.transaction(async (em) => {
      b.status = 'cancelled';
      await em.save(b);
      for (const d of eachDay(b.checkIn, b.checkOut)) {
        await em.decrement(DailyInventory, { roomTypeId: b.roomTypeId, date: d }, 'booked', 1);
      }
    });
    return { ok: true };
  }

  // 客人临时加人：更新人数与早餐份数，重算费用，并记入住宿链路事件
  @Post(':id/extra-guests')
  async extraGuests(@Param('id') id: number,
                    @Body() body: { adults?: number; children?: number; breakfastCount?: number }) {
    const b = await this.bookings.findOne({ where: { id }, relations: ['roomType'] });
    if (!b) throw new NotFoundException('订单不存在');
    if (b.status === 'cancelled' || b.status === 'checked_out') throw new BadRequestException('订单已结束');
    const changes: string[] = [];
    if (body.adults !== undefined && body.adults !== b.adults) {
      if (body.adults > b.roomType.maxAdults + b.extraBeds) throw new BadRequestException('超过房型入住上限，请先加床');
      changes.push(`成人 ${b.adults}→${body.adults}`);
      b.adults = body.adults;
    }
    if (body.children !== undefined && body.children !== b.children) {
      changes.push(`儿童 ${b.children}→${body.children}`);
      b.children = body.children;
    }
    if (body.breakfastCount !== undefined && body.breakfastCount !== b.breakfastCount) {
      changes.push(`早餐 ${b.breakfastCount}→${body.breakfastCount} 份/天`);
      b.breakfastCount = body.breakfastCount;
    }
    if (!changes.length) throw new BadRequestException('没有变更内容');
    b.breakfastFee = round2(b.breakfastCount * b.nights * Number(b.roomType.breakfastPrice));
    b.totalAmount = round2(Number(b.roomFee) + Number(b.extraBedFee) + b.breakfastFee + Number(b.petFee));
    await this.dataSource.transaction(async (em) => {
      await em.save(b);
      await em.save(em.create(Incident, {
        type: 'extra_guests', bookingId: b.id, roomId: b.roomId,
        description: `订单 ${b.code} 临时加人：${changes.join('，')}，早餐费重算为 ¥${b.breakfastFee}`,
        status: 'resolved', cost: 0, resolvedAt: new Date(), resolution: '费用已重算',
      }));
    });
    return this.buildDetail(id);
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([
    Booking, Room, Channel, DailyInventory, DailyPrice, CleaningTask, Incident, Review, Compensation,
  ])],
  controllers: [BookingsController],
})
export class BookingsModule {}
