import {
  BadRequestException, Body, Controller, Get, Module, Post, Query,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import {
  Booking, BreakfastPrep, Compensation, DailyInventory, Incident,
  LinenDelivery, LinenItem, MaintenanceTicket, Review, Room, RoomType, CleaningTask,
} from '../entities';
import { Roles } from '../common/auth';
import { addDays, diffDays, eachDay, overlapNights, round2, todayStr } from '../common/util';

const CLEANING_COST_PER_TASK = 35; // 单次保洁成本
const LINEN_WASH_COST = 6;         // 单套布草洗涤成本
const BREAKFAST_COST_PER_PORTION = 15; // 单份早餐成本

@Controller('analytics')
@Roles('owner', 'housekeeper')
export class AnalyticsController {
  constructor(
    @InjectRepository(Booking) private bookings: Repository<Booking>,
    @InjectRepository(Room) private rooms: Repository<Room>,
    @InjectRepository(RoomType) private types: Repository<RoomType>,
    @InjectRepository(Incident) private incidents: Repository<Incident>,
    @InjectRepository(Review) private reviews: Repository<Review>,
    @InjectRepository(Compensation) private compensations: Repository<Compensation>,
    @InjectRepository(CleaningTask) private cleaning: Repository<CleaningTask>,
    @InjectRepository(LinenItem) private linen: Repository<LinenItem>,
    @InjectRepository(LinenDelivery) private deliveries: Repository<LinenDelivery>,
    @InjectRepository(BreakfastPrep) private preps: Repository<BreakfastPrep>,
    @InjectRepository(DailyInventory) private inventory: Repository<DailyInventory>,
    @InjectRepository(MaintenanceTicket) private maintenance: Repository<MaintenanceTicket>,
  ) {}

  private async bookingsInRange(from: string, to: string) {
    const all = await this.bookings.find({ relations: ['channel', 'roomType', 'room'] });
    return all.filter((b) => b.status !== 'cancelled' && b.checkIn <= to && b.checkOut >= from);
  }

  // 经营看板
  @Get('dashboard')
  async dashboard(@Query('from') from?: string, @Query('to') to?: string) {
    const start = from || addDays(todayStr(), -7);
    const end = to || addDays(todayStr(), 7);
    const days = diffDays(start, end) + 1;
    const roomCount = await this.rooms.count();
    const bookings = await this.bookingsInRange(start, end);
    const soldNights = bookings.reduce((s, b) => s + overlapNights(b.checkIn, b.checkOut, start, addDays(end, 1)), 0);
    const roomNightsAvailable = roomCount * days;
    const revenue = bookings.reduce((s, b) => {
      const share = b.nights > 0 ? overlapNights(b.checkIn, b.checkOut, start, addDays(end, 1)) / b.nights : 0;
      return s + Number(b.totalAmount) * share;
    }, 0);
    const roomFeeRevenue = bookings.reduce((s, b) => {
      const share = b.nights > 0 ? overlapNights(b.checkIn, b.checkOut, start, addDays(end, 1)) / b.nights : 0;
      return s + Number(b.roomFee) * share;
    }, 0);
    const incidents = await this.incidents.find({ where: { occurredAt: Between(new Date(start), new Date(end + 'T23:59:59')) } });
    const byType: Record<string, number> = {};
    for (const i of incidents) byType[i.type] = (byType[i.type] || 0) + 1;
    const reviews = await this.reviews.find();
    const comps = await this.compensations.find();
    const compTotal = comps.filter((c) => c.status !== 'cancelled').reduce((s, c) => s + Number(c.amount), 0);
    const reviewByCat: Record<string, number> = {};
    for (const r of reviews) reviewByCat[r.category] = (reviewByCat[r.category] || 0) + 1;
    // 每日入住率曲线
    const daily = eachDay(start, end).map((d) => {
      const sold = bookings.reduce((s, b) => s + (b.checkIn <= d && b.checkOut > d ? 1 : 0), 0);
      return { date: d, sold, occupancy: roomCount ? round2((sold / roomCount) * 100) : 0 };
    });
    // 渠道收入
    const byChannel: Record<string, number> = {};
    for (const b of bookings) {
      const name = (b.channel as any)?.name || '未知';
      byChannel[name] = round2((byChannel[name] || 0) + Number(b.totalAmount));
    }
    return {
      range: { from: start, to: end },
      kpi: {
        occupancy: roomNightsAvailable ? round2((soldNights / roomNightsAvailable) * 100) : 0,
        soldNights, roomNightsAvailable,
        revenue: round2(revenue),
        adr: soldNights ? round2(roomFeeRevenue / soldNights) : 0,
        revpar: roomNightsAvailable ? round2(roomFeeRevenue / roomNightsAvailable) : 0,
        compensationCost: round2(compTotal),
        reviewCount: reviews.length,
        badReviewCount: reviews.filter((r) => r.rating <= 3).length,
        avgRating: reviews.length ? round2(reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) : 0,
      },
      incidentsByType: Object.entries(byType).map(([type, count]) => ({ type, count })),
      reviewByCategory: Object.entries(reviewByCat).map(([category, count]) => ({ category, count })),
      daily,
      revenueByChannel: Object.entries(byChannel).map(([name, value]) => ({ name, value })),
    };
  }

  // 旺季复盘：分渠道/房型利润 + 服务环节成本 + 问题归类
  @Get('profit')
  async profit(@Query('from') from?: string, @Query('to') to?: string) {
    const start = from || addDays(todayStr(), -14);
    const end = to || todayStr();
    const bookings = (await this.bookingsInRange(start, end))
      .filter((b) => b.checkIn >= start && b.checkIn <= end);
    const comps = await this.compensations.find();
    const compOf = (id: number) => comps.filter((c) => c.bookingId === id && c.status !== 'cancelled')
      .reduce((s, c) => s + Number(c.amount), 0);

    const group = (keyOf: (b: Booking) => string) => {
      const map = new Map<string, any>();
      for (const b of bookings) {
        const k = keyOf(b);
        const cur = map.get(k) || { name: k, bookings: 0, gross: 0, commission: 0, compensation: 0, depositKept: 0, net: 0 };
        const commission = Number(b.roomFee) * Number((b.channel as any)?.commissionRate || 0);
        const comp = compOf(b.id);
        cur.bookings += 1;
        cur.gross = round2(cur.gross + Number(b.totalAmount));
        cur.commission = round2(cur.commission + commission);
        cur.compensation = round2(cur.compensation + comp);
        cur.depositKept = round2(cur.depositKept + Number(b.depositDeducted));
        cur.net = round2(cur.net + Number(b.totalAmount) - commission - comp + Number(b.depositDeducted));
        map.set(k, cur);
      }
      return [...map.values()].map((r) => ({ ...r, margin: r.gross ? round2((r.net / r.gross) * 100) : 0 }));
    };

    // 服务环节收入与成本
    const seg = bookings.reduce((acc, b) => ({
      roomFee: round2(acc.roomFee + Number(b.roomFee)),
      extraBed: round2(acc.extraBed + Number(b.extraBedFee)),
      breakfast: round2(acc.breakfast + Number(b.breakfastFee)),
      petFee: round2(acc.petFee + Number(b.petFee)),
    }), { roomFee: 0, extraBed: 0, breakfast: 0, petFee: 0 });
    const cleaningTasks = await this.cleaning.find({ where: { date: Between(start, end) } });
    const linenUsed = cleaningTasks.reduce((s, t) => s + t.linenUsed, 0);
    const preps = await this.preps.find({ where: { date: Between(start, end) } });
    const breakfastPortions = preps.reduce((s, p) => s + p.preparedPortions, 0);
    const maintenanceCost = (await this.maintenance.find())
      .reduce((s, m) => s + Number(m.cost), 0);
    const totalComp = comps.filter((c) => c.status !== 'cancelled').reduce((s, c) => s + Number(c.amount), 0);
    const totalCommission = bookings.reduce((s, b) => s + Number(b.roomFee) * Number((b.channel as any)?.commissionRate || 0), 0);
    const costs = {
      cleaning: round2(cleaningTasks.length * CLEANING_COST_PER_TASK),
      linen: round2(linenUsed * LINEN_WASH_COST),
      breakfast: round2(breakfastPortions * BREAKFAST_COST_PER_PORTION),
      maintenance: round2(maintenanceCost),
      compensation: round2(totalComp),
      commission: round2(totalCommission),
    };
    const grossTotal = round2(seg.roomFee + seg.extraBed + seg.breakfast + seg.petFee);
    const costTotal = round2(Object.values(costs).reduce((s, v) => s + v, 0));

    // 问题归类：价格策略 / 履约能力 / 个别客诉
    const incidents = await this.incidents.find();
    const fulfillmentTypes = ['linen_delay', 'breakfast_shortage', 'oversell', 'ac_failure', 'late_checkout'];
    const fulfillmentCount = incidents.filter((i) => fulfillmentTypes.includes(i.type)).length;
    const reviews = await this.reviews.find();
    const badReviews = reviews.filter((r) => r.rating <= 3);
    const classification: any[] = [];
    const byChannelList = group((b) => (b.channel as any)?.name || '未知');
    // 价格策略问题：渠道间净利率差距大（高佣金/低价渠道侵蚀利润）
    const margins = byChannelList.filter((c) => c.gross > 0).map((c) => c.margin);
    const worst = byChannelList.filter((c) => c.gross > 0)
      .sort((a, b) => a.margin - b.margin)[0];
    if (margins.length >= 2 && Math.max(...margins) - Math.min(...margins) >= 5 && worst) {
      classification.push({
        type: '价格策略问题',
        evidence: `渠道「${worst.name}」净利率 ${worst.margin}%（佣金 ¥${worst.commission}），与最优渠道相差 ${round2(Math.max(...margins) - Math.min(...margins))} 个百分点`,
        suggestion: '下调高佣金渠道配额或上调该渠道挂牌价；提升官网/电话等直销占比',
      });
    }
    if (fulfillmentCount > 0) {
      const counts: Record<string, number> = {};
      for (const i of incidents.filter((x) => fulfillmentTypes.includes(x.type))) counts[i.type] = (counts[i.type] || 0) + 1;
      classification.push({
        type: '履约能力问题',
        evidence: `旺季共 ${fulfillmentCount} 起履约事件：${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join('、')}`,
        suggestion: '增加保洁排班与布草安全库存，早餐按上限备餐，超卖房型下调可售房量',
      });
    }
    const complaintCats = [...new Set(badReviews.map((r) => r.category))];
    if (badReviews.length) {
      classification.push({
        type: '个别客诉',
        evidence: `${badReviews.length} 条差评，集中在 ${complaintCats.join('、')} 类，补偿支出 ¥${round2(totalComp)}`,
        suggestion: '对硬件类差评安排检修复核；服务类差评纳入管家培训；及时补偿止损',
      });
    }

    return {
      range: { from: start, to: end },
      byChannel: byChannelList,
      byRoomType: group((b) => (b.roomType as any)?.name || '未知'),
      serviceSegments: { revenue: seg, costs, grossTotal, costTotal, net: round2(grossTotal - costTotal) },
      classification,
    };
  }

  // 当日运营成本：保洁/布草洗涤/早餐/维修/补偿（含布草延迟补偿）逐日归集
  @Get('daily-costs')
  async dailyCosts(@Query('date') date?: string) {
    const d = date || todayStr();
    const dayStart = new Date(`${d}T00:00:00+08:00`);
    const dayEnd = new Date(`${d}T23:59:59.999+08:00`);
    const inDay = (t: Date) => t && new Date(t) >= dayStart && new Date(t) <= dayEnd;
    const cleaningTasks = await this.cleaning.find({ where: { date: d } });
    const linenUsed = cleaningTasks.reduce((s, t) => s + t.linenUsed, 0);
    const prep = await this.preps.findOne({ where: { date: d } });
    const maintenance = (await this.maintenance.find()).filter((m) => inDay(m.reportedAt));
    const comps = (await this.compensations.find({ order: { id: 'DESC' } }))
      .filter((c) => c.status !== 'cancelled' && inDay(c.createdAt));
    const costs = {
      cleaning: round2(cleaningTasks.length * CLEANING_COST_PER_TASK),
      linen: round2(linenUsed * LINEN_WASH_COST),
      breakfast: round2((prep?.preparedPortions || 0) * BREAKFAST_COST_PER_PORTION),
      maintenance: round2(maintenance.reduce((s, m) => s + Number(m.cost), 0)),
      compensation: round2(comps.reduce((s, c) => s + Number(c.amount), 0)),
    };
    const total = round2(Object.values(costs).reduce((s, v) => s + v, 0));
    return {
      date: d, costs, total,
      details: {
        cleaningTasks: cleaningTasks.length,
        linenUsed,
        breakfastPortions: prep?.preparedPortions || 0,
        maintenanceTickets: maintenance.length,
        compensations: comps.map((c) => ({
          id: c.id, type: c.type, amount: c.amount, reason: c.reason, bookingId: c.bookingId,
        })),
      },
    };
  }

  // 下一轮节假日可售房量建议：根据超卖、布草延迟、早餐投诉、补偿成本自动调整
  @Get('adjustment')
  async adjustment() {
    const types = await this.types.find({ order: { id: 'ASC' } });
    const rooms = await this.rooms.find();
    const incidents = await this.incidents.find();
    const bookings = await this.bookings.find({ relations: ['channel'] });
    const comps = await this.compensations.find();
    const deliveries = await this.deliveries.find();
    const now = new Date();
    // 延迟率：已记延迟 + 逾期未到的在途配送（如山路堵车）都算延迟风险
    const linenDelayCount = deliveries.filter((d) =>
      d.status === 'delayed' || (d.status === 'scheduled' && new Date(d.expectedAt) < now)).length;
    const linenDelayRate = deliveries.length ? linenDelayCount / deliveries.length : 0;
    const breakfastShortages = incidents.filter((i) => i.type === 'breakfast_shortage').length;

    const rows = types.map((t) => {
      const total = rooms.filter((r) => r.roomTypeId === t.id).length;
      const typeBookings = bookings.filter((b) => b.roomTypeId === t.id);
      const oversellCount = incidents.filter((i) => i.type === 'oversell'
        && typeBookings.some((b) => b.id === i.bookingId)).length;
      const gross = typeBookings.reduce((s, b) => s + Number(b.totalAmount), 0);
      const compCost = comps.filter((c) => typeBookings.some((b) => b.id === c.bookingId))
        .reduce((s, c) => s + Number(c.amount), 0);
      const compRatio = gross > 0 ? compCost / gross : 0;
      const reasons: string[] = [];
      let reduction = 0;
      if (oversellCount > 0) { reduction += Math.min(2, oversellCount); reasons.push(`超卖 ${oversellCount} 起，预留缓冲房`); }
      if (linenDelayRate > 0.2) { reduction += 1; reasons.push(`布草延迟率 ${round2(linenDelayRate * 100)}%，保洁周转受限`); }
      if (breakfastShortages >= 1) { reduction += 1; reasons.push(`早餐供应不足 ${breakfastShortages} 天，厨房接待能力受限`); }
      if (compRatio > 0.05) { reduction += 1; reasons.push(`补偿成本占收入 ${round2(compRatio * 100)}%，履约风险高`); }
      const adjusted = Math.max(Math.ceil(total / 2), total - reduction);
      return {
        typeId: t.id, typeName: t.name, total, adjustedSellable: adjusted,
        reduction: total - adjusted, oversellCount, breakfastShortages,
        linenDelayRate: round2(linenDelayRate * 100), compCost: round2(compCost),
        compRatio: round2(compRatio * 100), reasons,
      };
    });
    return { rows };
  }

  // 应用调整：为下一轮节假日生成调整后的可售库存
  @Post('apply-adjustment')
  async applyAdjustment(@Body() body: { from: string; to: string }) {
    if (!body.from || !body.to) throw new BadRequestException('日期必填');
    const { rows } = await this.adjustment();
    const sellableByType = Object.fromEntries(rows.map((r) => [r.typeId, r.adjustedSellable]));
    const types = await this.types.find();
    const rooms = await this.rooms.find();
    for (const t of types) {
      const total = rooms.filter((r) => r.roomTypeId === t.id).length;
      for (const d of eachDay(body.from, addDays(body.to, 1))) {
        let inv = await this.inventory.findOne({ where: { roomTypeId: t.id, date: d } });
        if (!inv) inv = this.inventory.create({ roomTypeId: t.id, date: d, booked: 0 });
        inv.total = total;
        inv.sellable = Math.min(sellableByType[t.id] ?? total, total);
        await this.inventory.save(inv);
      }
    }
    return { ok: true, applied: sellableByType, range: { from: body.from, to: body.to } };
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([
    Booking, Room, RoomType, Incident, Review, Compensation, CleaningTask,
    LinenItem, LinenDelivery, BreakfastPrep, DailyInventory, MaintenanceTicket,
  ])],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
