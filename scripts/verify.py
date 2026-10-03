#!/usr/bin/env python3
"""端到端验证脚本：覆盖登录、订单、房态、保洁、布草、早餐、事件、差评补偿、结算、复盘、调价。"""
import json, subprocess, sys
from datetime import datetime, timedelta, timezone

BASE = 'http://localhost:3000/api'
TODAY_CN = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
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
check('超时签收记为延迟', dv2['status'] == 'delayed')
inc = call('GET', '/incidents?type=linen_delay&status=open', T)
check('布草延迟事件生成', len(inc) >= 1)

print('== 4.5 布草延迟影响入住 ==')
# 种子故事线：203 保洁完成但布草车山路堵车未到，房间待布草，苏女士等待入住
sh = call('GET', '/linen/shortages?status=waiting', T)
check('存在等待中的布草缺口', len(sh) >= 1)
s203 = [x for x in sh if x['roomCode'] == '203'][0]
check('缺口记录含客人/预计到达/等待时长',
      s203['guestName'] == '苏女士' and bool(s203['expectedAt']) and s203['waitingMinutes'] >= 0)
rooms_now = call('GET', '/rooms', T)
check('203 房态为待布草', [r for r in rooms_now if r['code'] == '203'][0]['status'] == 'awaiting_linen')
bk20 = [b for b in call('GET', '/bookings', T) if b['guestName'] == '苏女士'][0]
ci = call('POST', f"/bookings/{bk20['id']}/check-in", T)
check('待布草房间不可办理入住', ci.get('statusCode') == 400, ci.get('message', '')[:30])
alt = call('GET', f"/linen/shortages/{s203['id']}/alternatives", T)
check('可调拨房间非空且不含本房', len(alt['rooms']) >= 1 and all(r['code'] != '203' for r in alt['rooms']))
check('可调拨房间均可入住', all(r['status'] in ('clean', 'inspected') for r in alt['rooms']))
# 管家补偿：下午茶 + 延迟入住补偿 → 计入当日运营成本
costs_before = call('GET', f'/analytics/daily-costs?date={TODAY_CN}', T)['costs']['compensation']
c1 = call('POST', f"/linen/shortages/{s203['id']}/compensate", T, {'action': 'afternoon_tea', 'amount': 68})
check('下午茶补偿发放', c1['compensation']['type'] == 'afternoon_tea' and c1['compensation']['amount'] == 68)
c2 = call('POST', f"/linen/shortages/{s203['id']}/compensate", T, {'action': 'late_checkin', 'amount': 200})
check('延迟入住补偿发放', c2['compensation']['type'] == 'late_checkin' and c2['compensation']['amount'] == 200)
costs_after = call('GET', f'/analytics/daily-costs?date={TODAY_CN}', T)
check('补偿费用进入当日运营成本',
      abs(costs_after['costs']['compensation'] - costs_before - 268) < 0.01,
      f"{costs_before} → {costs_after['costs']['compensation']}")
check('当日成本含补偿明细', any(c['type'] == 'late_checkin' for c in costs_after['details']['compensations']))
# 调拨换房：苏女士 203 → 401（免费升级），订单房间变更、缺口记为已调拨
target = [r for r in alt['rooms'] if r['code'] == '401'][0]
rc = call('POST', f"/linen/shortages/{s203['id']}/compensate", T, {'action': 'room_change', 'toRoomId': target['roomId']})
check('调拨换房成功', rc['shortage']['status'] == 'relocated')
check('订单房间已变更', rc['booking']['roomId'] == target['roomId'])
ci2 = call('POST', f"/bookings/{bk20['id']}/check-in", T)
check('调拨后可办理入住', ci2.get('status') == 'checked_in')
# 再登记一个缺口（103 房许先生明日入住），验证布草到达后自动恢复
bk9 = [b for b in call('GET', '/bookings', T) if b['guestName'] == '许先生'][0]
r103 = [r for r in rooms_now if r['code'] == '103'][0]
sh2 = call('POST', '/linen/shortages', T, {'roomId': r103['id'], 'bookingId': bk9['id'],
    'item': '床单', 'quantity': 1, 'expectedAt': '2026-10-03T16:00:00+08:00'})
check('登记布草缺口', sh2.get('id') is not None)
check('登记后103房态待布草', [r for r in call('GET', '/rooms', T) if r['code'] == '103'][0]['status'] == 'awaiting_linen')
stuck = [d for d in call('GET', '/linen/deliveries', T) if d['item'] == '床单' and d['status'] == 'scheduled'][0]
arr = call('POST', f"/linen/deliveries/{stuck['id']}/arrive", T)
check('布草到达自动解除缺口并恢复房态', set(arr.get('resolvedRooms', [])) == {'203', '103'}, str(arr.get('resolvedRooms')))
rooms_end = call('GET', '/rooms', T)
check('203/103 房态自动转为可入住',
      [r for r in rooms_end if r['code'] == '203'][0]['status'] == 'clean'
      and [r for r in rooms_end if r['code'] == '103'][0]['status'] == 'clean')
sh_all = call('GET', '/linen/shortages', T)
check('到达后缺口自动关闭', [x for x in sh_all if x['id'] == sh2['id']][0]['status'] == 'resolved')
# 布草延迟多次出现 → 平台建议
adv = call('GET', '/linen/delay-advice', T)
check('布草延迟统计(多次)', adv['delayCount'] >= 2, f"delayCount={adv['delayCount']}")
adv_types = {s['type'] for s in adv['suggestions']}
check('建议含安全库存/供应商/限连住', adv_types == {'safety_stock', 'supplier', 'limit_long_stay'}, str(adv_types))

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
