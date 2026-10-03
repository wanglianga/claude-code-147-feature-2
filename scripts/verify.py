#!/usr/bin/env python3
"""端到端验证脚本：覆盖登录、订单、房态、保洁、布草、早餐、事件、差评补偿、结算、复盘、调价。"""
import json, subprocess, sys

BASE = 'http://localhost:3000/api'
def call(method, path, token=None, body=None):
    cmd = ['curl', '-s', '-X', method, BASE + path, '-H', 'Content-Type: application/json']
    if token: cmd += ['-H', f'Authorization: Bearer {token}']
    if body is not None: cmd += ['-d', json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    try: return json.loads(out)
    except Exception: return {'_raw': out}

ok = fail = 0
def check(name, cond, extra=''):
    global ok, fail
    if cond: ok += 1; print(f'  PASS {name} {extra}')
    else: fail += 1; print(f'  FAIL {name} {extra}')

login = call('POST', '/auth/login', body={'username': 'owner', 'password': '123456'})
T = login['token']
print('== 1. 认证 ==')
check('登录签发JWT', bool(T))
check('错误密码被拒', 'statusCode' in call('POST', '/auth/login', body={'username': 'owner', 'password': 'wrong'}))

print('== 2. 房态与库存 ==')
cal = call('GET', '/calendar?from=2026-10-03&to=2026-10-08', T)
check('日历 12间房', len(cal['rooms']) == 12)
inv = call('GET', '/inventory?from=2026-10-01&to=2026-10-08', T)
oversold = [(r['typeName'], d['date']) for r in inv for d in r['days'] if d['oversold']]
check('超卖被识别(10-01双床/10-04大床)', len(oversold) >= 2, str(oversold))

print('== 3. 订单全链路 ==')
bookings = call('GET', '/bookings', T)
check('20张种子订单', len(bookings) == 20)
b3 = [b for b in bookings if b['guestName'] == '王先生一家'][0]
detail = call('GET', f"/bookings/{b3['id']}", T)
check('订单详情含事件链', len(detail['incidents']) >= 2)  # ac_failure + bad_review
check('订单详情含保洁任务', detail['cleaningTask'] is not None)
check('订单详情含差评', detail['review'] and detail['review']['rating'] == 2)
check('结算含佣金/补偿/押金行', len(detail['settlement']['lines']) == 7)
s = detail['settlement']
check('结算净额=应收-佣金-补偿+押金扣留',
      abs(s['net'] - (s['gross'] - s['commission'] - s['compensation'] + s['deposit']['deducted'])) < 0.01)

# 规则校验：禁宠房型带宠物应被拒
rooms = call('GET', '/rooms', T)
channels = call('GET', '/channels', T)
r101 = [r for r in rooms if r['code'] == '101'][0]
ota = [c for c in channels if c['code'] == 'ota'][0]
bad = call('POST', '/bookings', T, {'roomId': r101['id'], 'channelId': ota['id'], 'guestName': '测试',
    'checkIn': '2026-10-10', 'checkOut': '2026-10-11', 'adults': 2, 'pets': 1})
check('禁宠房型带宠物被拒', bad.get('statusCode') == 400, bad.get('message', ''))
# 库存不足非强制应 409
full = call('POST', '/bookings', T, {'roomId': r101['id'], 'channelId': ota['id'], 'guestName': '测试超售',
    'checkIn': '2026-10-04', 'checkOut': '2026-10-05', 'adults': 2})
check('库存不足返回409', full.get('statusCode') == 409, full.get('message', ''))
# OTA 强制下单 → 超卖事件
forced = call('POST', '/bookings', T, {'roomId': r101['id'], 'channelId': ota['id'], 'guestName': '测试强推',
    'checkIn': '2026-10-04', 'checkOut': '2026-10-05', 'adults': 2, 'force': True})
check('OTA强制下单成功', forced.get('code', '').startswith('BK'))
check('强制单触发超卖事件', any(i['type'] == 'oversell' for i in forced.get('incidents', [])))
new_id = forced['id']
# 入住→临时加人→退房(延迟)→保洁任务
call('POST', f'/bookings/{new_id}/check-in', T)
eg = call('POST', f'/bookings/{new_id}/extra-guests', T, {'breakfastCount': 3})
check('临时加人重算早餐费', eg['breakfastFee'] == 3 * eg['nights'] * 38)
co = call('POST', f'/bookings/{new_id}/check-out', T, {'actualTime': '2026-10-05T14:00:00+08:00', 'dirtiness': 'heavy'})
check('延迟退房事件生成', any(i['type'] == 'late_checkout' for i in co['incidents']))
check('退房生成保洁任务', co['cleaningTask'] is not None and co['cleaningTask']['dirtiness'] == 'heavy')
check('押金已退', co['settlement']['deposit']['returned'] == 500)

print('== 4. 保洁与布草 ==')
plan = call('POST', '/cleaning/auto-schedule', T, {'date': '2026-10-03'})
check('智能排班产出方案', len(plan['plan']) >= 1)
check('排班含维修冲突告警', any(w for p in plan['plan'] for w in p['warnings']))
task_id = plan['plan'][0]['taskId']
call('POST', f'/cleaning/tasks/{task_id}/start', T)
stock_before = {s['item']: s['available'] for s in call('GET', '/linen/stock', T)}
call('POST', f'/cleaning/tasks/{task_id}/complete', T, {'linenUsed': 2})
stock_after = {s['item']: s['available'] for s in call('GET', '/linen/stock', T)}
check('完成保洁消耗布草', stock_after['床单'] == stock_before['床单'] - 2)
insp = call('POST', f'/cleaning/tasks/{task_id}/inspect', T)
check('保洁验收', insp['status'] == 'inspected')
# 布草延迟事件
dv = call('POST', '/linen/deliveries', T, {'item': '毛巾', 'quantity': 10, 'expectedAt': '2026-10-01T08:00:00+08:00'})
dv2 = call('POST', f"/linen/deliveries/{dv['id']}/arrive", T)
check('超时签收记为延迟', dv2['delivery']['status'] == 'delayed')
inc = call('GET', '/incidents?type=linen_delay&status=open', T)
check('布草延迟事件生成', len(inc) >= 1)

print('== 4b. 布草堵车·待布草阻塞入住全链路 ==')
# 种子已埋：103 房保洁已完成、布草车山路堵车未到，沈女士一家提前到店等待
blocks = call('GET', '/linen/blocks', T)
b103 = [b for b in blocks if b['room']['code'] == '103' and b['status'] == 'active'][0]
check('平台记录布草缺口/ETA', b103['item'] == '床单' and b103['shortage'] == 1 and bool(b103['expectedAt']))
check('平台记录客人等待时间', b103['waitedMinutes'] > 0 and b103['booking']['guestName'] == '沈女士一家')
check('平台匹配可调拨房间', any(r['code'] == '101' for r in b103['transferRooms']))
bk20 = b103['booking']['id']
deny = call('POST', f'/bookings/{bk20}/check-in', T)
check('待布草房入住被409拦截', deny.get('statusCode') == 409, deny.get('message', ''))
# 管家补偿：下午茶 + 延迟入住
c1 = call('POST', f"/linen/blocks/{b103['id']}/compensate", T, {'type': 'afternoon_tea', 'amount': 30})
check('下午茶补偿登记', c1.get('linenBlockId') == b103['id'] and float(c1['amount']) == 30)
c2 = call('POST', f"/linen/blocks/{b103['id']}/compensate", T, {'type': 'late_checkin', 'amount': 40})
check('延迟入住补偿登记', c2.get('type') == 'late_checkin' and float(c2['amount']) == 40)
badcomp = call('POST', f"/linen/blocks/{b103['id']}/compensate", T, {'type': 'room_change', 'amount': 1})
check('换房不走补偿接口', badcomp.get('statusCode') == 400)
oc1 = call('GET', '/linen/ops-cost?date=2026-10-03', T)
check('待客补偿进入当日运营成本', float(oc1['linenGuestCompensation']) >= 138, str(oc1['linenGuestCompensation']))  # 种子68 + 30 + 40
check('当日成本按补偿类型拆分', float(oc1['byType']['afternoon_tea']) == 98 and float(oc1['byType']['late_checkin']) == 40, str(oc1['byType']))
# 布草到达：房态自动从待布草转为可入住，事件自动关闭
arr = call('POST', f"/linen/deliveries/{b103['delivery']['id']}/arrive", T)
check('签收联动恢复待布草房', b103['id'] in arr.get('resolvedBlockIds', []))
rooms2 = call('GET', '/rooms', T)
check('房态自动转为可入住', [r for r in rooms2 if r['code'] == '103'][0]['status'] == 'inspected')
ci = call('POST', f'/bookings/{bk20}/check-in', T)
check('布草到达后可办理入住', ci.get('status') == 'checked_in')
inc103 = call('GET', '/incidents?type=linen_delay', T)
check('布草延迟事件自动关闭', all(i['status'] == 'resolved' for i in inc103 if i.get('roomId') == b103['roomId']))
oc2 = call('GET', '/linen/ops-cost?date=2026-10-03', T)
check('当日运营成本保留补偿合计', float(oc2['total']) >= 138)

# 管家手工登记缺口 + 换房调拨（403 跨房型调到空房 203）
r403 = [r for r in rooms2 if r['code'] == '403'][0]
r203 = [r for r in rooms2 if r['code'] == '203'][0]
web_c = [c for c in call('GET', '/channels', T) if c['code'] == 'web'][0]
nb = call('POST', '/bookings', T, {'roomId': r403['id'], 'channelId': web_c['id'], 'guestName': '布草换房测试',
    'checkIn': '2026-10-03', 'checkOut': '2026-10-04', 'adults': 2})
def inv_booked(type_name, date='2026-10-03'):
    rows = call('GET', f'/inventory?from={date}&to={date}', T)
    t = [r for r in rows if r['typeName'] == type_name][0]
    return t['days'][0]['booked']
loft_before, twin_before = inv_booked('Loft观景套房'), inv_booked('庭院双床房')
bl2 = call('POST', '/linen/blocks', T, {'roomId': r403['id'], 'bookingId': nb['id'], 'item': '被套', 'shortage': 1,
    'expectedAt': '2026-10-03T23:00:00+08:00', 'transferRoomIds': [r203['id']]})
check('手工登记待布草并接受指定调拨房', bl2.get('status') == 'active'
      and any(x['code'] == '203' for x in bl2.get('transferRooms', [])), str(bl2.get('transferRooms')))
dup = call('POST', '/linen/blocks', T, {'roomId': r403['id'], 'expectedAt': '2026-10-03T23:00:00+08:00'})
check('同房重复登记被拒', dup.get('statusCode') == 400)
rc = call('POST', f"/linen/blocks/{bl2['id']}/room-change", T, {'targetRoomId': r203['id'], 'amount': 0})
check('换房调拨成功', rc.get('type') == 'room_change')
nb2 = call('GET', f"/bookings/{nb['id']}", T)
check('订单已调至203房', nb2['room']['code'] == '203')
check('换房同步转移房型库存占用',
      inv_booked('Loft观景套房') == loft_before - 1 and inv_booked('庭院双床房') == twin_before + 1,
      f"{loft_before}->{inv_booked('Loft观景套房')}, {twin_before}->{inv_booked('庭院双床房')}")
# 被套随后送达：原 403 房自动恢复可入住
dvq = call('POST', '/linen/deliveries', T, {'item': '被套', 'quantity': 5, 'expectedAt': '2026-10-03T12:00:00+08:00'})
call('POST', f"/linen/deliveries/{dvq['id']}/arrive", T)
rooms4 = call('GET', '/rooms', T)
check('布草到达原房恢复可入住', [r for r in rooms4 if r['code'] == '403'][0]['status'] == 'inspected')

# 布草延迟多次出现：平台提示增加安全库存 / 调整供应商 / 限制高峰连住
adv = call('GET', '/analytics/linen-advice', T)
check('多次延迟触发三类处置建议', {a['type'] for a in adv['advices']} >= {'safety_stock', 'supplier', 'peak_limit'})
check('供应商延迟被统计归因', any(s['delayed'] > 0 and s['delayRate'] > 0 for s in adv['suppliers']))
sa = call('POST', '/analytics/linen-action', T, {'type': 'safety_stock', 'items': [{'item': '床单', 'safetyStock': 20}]})
check('增加安全库存动作落地', sa.get('ok') is True)
stk = {s['item']: s for s in call('GET', '/linen/stock', T)}
check('安全库存已上调并标记安全线', stk['床单']['safetyStock'] == 20 and 'belowSafety' in stk['床单'])
sup = call('POST', '/analytics/linen-action', T, {'type': 'supplier', 'supplier': '县城洁净洗涤厂（清晨首班）'})
check('调整洗涤供应商动作记录', sup.get('ok') is True)
pl = call('POST', '/analytics/linen-action', T, {'type': 'peak_limit', 'from': '2026-10-04', 'to': '2026-10-05'})
check('限制高峰连住房量已执行', pl.get('ok') is True and pl['changed'] >= 1)

print('== 5. 早餐 ==')
bp = call('GET', '/breakfast/plan?date=2026-10-04', T)
check('早餐需求按在住汇总', bp['required'] > 0, f"required={bp['required']}")
check('忌口汇总非空', len(bp['dietary']) >= 1)
conf = call('POST', '/breakfast/confirm', T, {'date': '2026-10-04', 'prepared': bp['required'] - 2})
check('备餐不足标记shortage', conf['status'] == 'shortage')
inc2 = call('GET', '/incidents?type=breakfast_shortage&status=open', T)
check('早餐不足事件生成', len(inc2) >= 1)

print('== 6. 差评与补偿 ==')
reviews = call('GET', '/reviews', T)
uncomp = [r for r in reviews if r['rating'] <= 3 and not r['compensated']]
check('存在待补偿差评', len(uncomp) >= 2)
comp = call('POST', f"/compensations/for-review/{uncomp[0]['id']}", T, {'type': 'voucher', 'amount': 120})
check('补偿券生成券码', comp.get('voucherCode', '').startswith('VC'))
used = call('POST', f"/compensations/{comp['id']}/use", T)
check('补偿券核销', used['status'] == 'used')
rv = call('POST', '/reviews', T, {'bookingId': new_id, 'rating': 2, 'category': 'service', 'content': '测试差评'})
check('新差评自动生成事件', rv.get('id') is not None)
inc3 = call('GET', '/incidents?type=bad_review&status=open', T)
check('差评事件在链路中', len(inc3) >= 1)

print('== 7. 结算 ==')
st = call('GET', '/settlements?from=2026-10-01&to=2026-10-08', T)
check('结算列表非空', len(st['list']) >= 15)
check('合计=各行求和', abs(st['totals']['net'] - sum(x['net'] for x in st['list'])) < 0.05)
ota_rows = [x for x in st['list'] if x['channelCode'] == 'ota']
check('OTA佣金=房费15%', all(abs(x['commission'] - x['lines'][0]['amount'] * 0.15) < 0.05 for x in ota_rows))

print('== 8. 复盘与调价 ==')
dash = call('GET', '/analytics/dashboard?from=2026-09-28&to=2026-10-08', T)
check('看板KPI完整', all(k in dash['kpi'] for k in ['occupancy', 'adr', 'revpar', 'compensationCost']))
check('差评归因四类可查', len(dash['reviewByCategory']) >= 3)
profit = call('GET', '/analytics/profit?from=2026-10-01&to=2026-10-08', T)
check('分渠道利润', len(profit['byChannel']) == 4)
check('分房型利润', len(profit['byRoomType']) == 4)
check('问题归类三类', {c['type'] for c in profit['classification']} == {'价格策略问题', '履约能力问题', '个别客诉'})
adj = call('GET', '/analytics/adjustment', T)
check('调价建议产出', len(adj['rows']) == 4)
t1 = [r for r in adj['rows'] if r['typeName'] == '山景大床房'][0]
check('超卖房型建议下调可售', t1['adjustedSellable'] < t1['total'], f"{t1['adjustedSellable']}/{t1['total']}")
applied = call('POST', '/analytics/apply-adjustment', T, {'from': '2026-12-31', 'to': '2027-01-02'})
check('调价应用成功', applied.get('ok') is True)
inv2 = call('GET', '/inventory?from=2026-12-31&to=2027-01-02', T)
t1row = [r for r in inv2 if r['typeName'] == '山景大床房'][0]
check('新周期可售=调整值', t1row['days'][0]['sellable'] == t1['adjustedSellable'])

print(f'\n结果: {ok} 通过, {fail} 失败')
sys.exit(1 if fail else 0)
