import {
  BadRequestException, Body, Controller, Get, Module, Post, Query,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import {
  Booking, BreakfastPrep, Compensation, DailyInventory, Incident,
  LinenAction, LinenBlock, LinenDelivery, LinenItem, MaintenanceTicket,
  Review, Room, RoomType, CleaningTask,
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
    @InjectRepository(LinenBlock) private linenBlocks: Repository<LinenBlock>,
    @InjectRepository(LinenAction) private linenActions: Repository<LinenAction>,
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

  // 下一轮节假日可售房量建议：根据超卖、布草延迟、早餐投诉、补偿成本自动调整
  @Get('adjustment')
  async adjustment() {
    const types = await this.types.find({ order: { id: 'ASC' } });
    const rooms = await this.rooms.find();
    const incidents = await this.incidents.find();
    const bookings = await this.bookings.find({ relations: ['channel'] });
    const comps = await this.compensations.find();
    const deliveries = await this.deliveries.find();
    const linenDelayCount = deliveries.filter((d) => d.status === 'delayed').length;
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

  // 布草延迟专项复盘：延迟次数/率、受堵房间与待客成本，以及三类处置建议
  @Get('linen-advice')
  async linenAdvice() {
    const deliveries = await this.deliveries.find({ order: { expectedAt: 'ASC' } });
    const delayed = deliveries.filter((d) => d.status === 'delayed');
    const delayRate = deliveries.length ? delayed.length / deliveries.length : 0;
    const blocks = await this.linenBlocks.find();
    const comps = await this.compensations.find();
    const items = await this.linen.find({ order: { id: 'ASC' } });
    const actions = await this.linenActions.find({ order: { id: 'DESC' } });
    const blockComps = comps.filter((c) => c.linenBlockId);
    const guestCost = round2(blockComps.reduce((s, c) => s + Number(c.amount), 0));
    const totalWait = blocks.reduce((s, b) => s + b.waitMinutes, 0);

    // 按供应商统计延迟（未登记供应商的归为“现洗涤供应商”）
    const supplierRows = Object.values(deliveries.reduce((acc: Record<string, any>, d) => {
      const name = d.supplier || '现洗涤供应商';
      acc[name] = acc[name] || { supplier: name, total: 0, delayed: 0, delayRate: 0 };
      acc[name].total += 1;
      if (d.status === 'delayed') acc[name].delayed += 1;
      acc[name].delayRate = round2((acc[name].delayed / acc[name].total) * 100);
      return acc;
    }, {}));
    const worstSupplier = [...supplierRows].sort((a, b) => b.delayRate - a.delayRate)[0];

    // 安全库存建议：现有安全库存不足总量 25% 的布草，建议补到 25%
    const stockAdvice = items.map((it) => {
      const suggested = Math.max(it.safetyStock, Math.ceil(it.total * 0.25));
      return {
        item: it.item, total: it.total,
        available: it.total - it.inUse - it.inWash - it.damaged,
        currentSafety: it.safetyStock, suggestedSafety: suggested,
        needRaise: suggested > it.safetyStock,
      };
    });

    const advices: any[] = [];
    if (delayed.length >= 2) {
      advices.push({
        type: 'safety_stock',
        title: '增加布草安全库存',
        evidence: `旺季已发生 ${delayed.length} 次布草延迟（延迟率 ${round2(delayRate * 100)}%），${blocks.length} 间房一度待布草，客人累计等待约 ${totalWait} 分钟`,
        suggestion: '按总保有量 25% 设置安全库存，库存触及安全线即提前催送并启用备用布草',
        payload: stockAdvice.filter((s) => s.needRaise),
      });
      advices.push({
        type: 'supplier',
        title: '调整洗涤供应商',
        evidence: worstSupplier
          ? `「${worstSupplier.supplier}」${worstSupplier.total} 次配送中 ${worstSupplier.delayed} 次延迟（${worstSupplier.delayRate}%），山路通行能力不足`
          : '暂无供应商配送数据',
        suggestion: '增加一家县城方向备用洗涤厂并签订旺季延时赔付条款，山路预警日改清晨首班送布',
        candidates: ['县城洁净洗涤厂（清晨首班）', '邻镇云洗供应链（备用）'],
      });
      advices.push({
        type: 'peak_limit',
        title: '限制高峰连住订单',
        evidence: `布草周转在连住高峰连续掉链，待客补偿已支出 ¥${guestCost}`,
        suggestion: '高峰日期各房型保留 1 间布草周转缓冲房，暂停连住 3 晚以上 OTA 订单超售',
      });
    } else if (delayed.length === 1) {
      advices.push({
        type: 'safety_stock',
        title: '关注布草库存',
        evidence: `已发生 1 次布草延迟（延迟率 ${round2(delayRate * 100)}%），若多次出现将影响入住交付`,
        suggestion: '建议预置安全库存并关注山路天气，暂不需要限制订单',
        payload: stockAdvice.filter((s) => s.needRaise),
      });
    }

    return {
      deliveryCount: deliveries.length,
      delayedCount: delayed.length,
      delayRate: round2(delayRate * 100),
      blockCount: blocks.length,
      activeBlockCount: blocks.filter((b) => b.status === 'active').length,
      totalWaitMinutes: totalWait,
      guestCompensation: guestCost,
      suppliers: supplierRows,
      stockAdvice,
      advices,
      actions,
    };
  }

  // 落地处置动作：增加安全库存 / 记录更换供应商 / 限制高峰连住房量
  @Post('linen-action')
  async linenAction(@Body() body: {
    type: string; supplier?: string; items?: { item: string; safetyStock: number }[];
    from?: string; to?: string;
  }) {
    if (body.type === 'safety_stock') {
      const rows = body.items || [];
      if (!rows.length) throw new BadRequestException('请提供要调整的布草安全库存');
      for (const r of rows) {
        const item = await this.linen.findOne({ where: { item: r.item } });
        if (!item) throw new BadRequestException(`布草「${r.item}」不存在`);
        item.safetyStock = Math.max(0, Math.floor(r.safetyStock));
        await this.linen.save(item);
      }
      const action = await this.linenActions.save(this.linenActions.create({
        type: 'safety_stock',
        detail: `上调安全库存：${rows.map((r) => `${r.item}→${r.safetyStock}件`).join('、')}`,
      }));
      return { ok: true, action };
    }
    if (body.type === 'supplier') {
      if (!body.supplier) throw new BadRequestException('请填写新供应商名称');
      const action = await this.linenActions.save(this.linenActions.create({
        type: 'supplier',
        detail: `调整洗涤供应商为「${body.supplier}」，签订旺季延时赔付与备用班次条款`,
      }));
      return { ok: true, action };
    }
    if (body.type === 'peak_limit') {
      if (!body.from || !body.to) throw new BadRequestException('请选择高峰日期区间');
      const types = await this.types.find();
      let changed = 0;
      for (const t of types) {
        for (const d of eachDay(body.from, addDays(body.to, 1))) {
          const inv = await this.inventory.findOne({ where: { roomTypeId: t.id, date: d } });
          if (inv && inv.sellable > 1) {
            inv.sellable = Math.min(inv.sellable, inv.total - 1);
            await this.inventory.save(inv);
            changed += 1;
          }
        }
      }
      const action = await this.linenActions.save(this.linenActions.create({
        type: 'peak_limit',
        detail: `${body.from} ~ ${body.to} 高峰区间每房型保留 1 间布草周转缓冲房，更新 ${changed} 条库存`,
      }));
      return { ok: true, changed, action };
    }
    throw new BadRequestException('动作类型需为 safety_stock / supplier / peak_limit');
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([
    Booking, Room, RoomType, Incident, Review, Compensation, CleaningTask,
    LinenItem, LinenDelivery, LinenBlock, LinenAction, BreakfastPrep, DailyInventory, MaintenanceTicket,
  ])],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
