import React, { useEffect, useState } from 'react';
import {
  Alert, Button, Card, Col, DatePicker, Descriptions, Form, Input, InputNumber, Modal,
  Popconfirm, Row, Select, Space, Statistic, Table, Tag, Timeline, message,
} from 'antd';
import dayjs from 'dayjs';
import api, { TASK_STATUS, DIRTINESS, BLOCK_STATUS, LINEN_COMP_TYPES } from '../api';

export default function Cleaning() {
  const [tasks, setTasks] = useState([]);
  const [stock, setStock] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [cleaners, setCleaners] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [plan, setPlan] = useState(null);
  const [opsCost, setOpsCost] = useState(null);
  const [advice, setAdvice] = useState(null);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [compTarget, setCompTarget] = useState(null);
  const [changeTarget, setChangeTarget] = useState(null);
  const [newDelivery, setNewDelivery] = useState({
    item: '床单', quantity: 12, expectedAt: dayjs('2026-10-05T09:00:00'),
    reason: '山路堵车', supplier: '山外洁净洗涤厂',
  });
  const [blockForm] = Form.useForm();
  const [compForm] = Form.useForm();
  const [changeForm] = Form.useForm();

  const load = async () => {
    const [t, s, d, b, u, r, bk, cost, adv] = await Promise.all([
      api.get('/cleaning/tasks'),
      api.get('/linen/stock'),
      api.get('/linen/deliveries'),
      api.get('/linen/blocks'),
      api.get('/auth/users').catch(() => []),
      api.get('/rooms'),
      api.get('/bookings', { params: { status: 'booked' } }),
      api.get('/linen/ops-cost').catch(() => null),
      api.get('/analytics/linen-advice').catch(() => null),
    ]);
    setTasks(t); setStock(s); setDeliveries(d); setBlocks(b);
    setCleaners(u.filter((x) => x.role === 'cleaner'));
    setRooms(r); setBookings(bk); setOpsCost(cost); setAdvice(adv);
  };
  useEffect(() => { load(); }, []);

  const act = async (fn, ok) => { await fn(); message.success(ok); load(); };

  const autoSchedule = async () => {
    const r = await api.post('/cleaning/auto-schedule', {});
    setPlan(r);
    load();
  };

  const activeBlocks = blocks.filter((b) => b.status === 'active');

  return (
    <div>
      {activeBlocks.length > 0 && (
        <Alert
          style={{ marginBottom: 16 }}
          type="error" showIcon
          message={`布草车堵车未到：${activeBlocks.length} 间房保洁已完成但处于「待布草」，客人无法按时入住`}
          description={activeBlocks.map((b) => (
            <Space key={b.id} wrap style={{ marginTop: 4 }}>
              <Tag color="volcano">{b.room.code} 房</Tag>
              缺 <b>{b.item}</b> {b.shortage} 套 · 预计 {dayjs(b.expectedAt).format('HH:mm')} 到 ·
              客人 <b>{b.booking?.guestName || '待定'}</b> 已等待 <b style={{ color: '#cf1322' }}>{b.waitedMinutes}</b> 分钟 ·
              可调拨：{b.transferRooms.length ? b.transferRooms.map((r) => r.code).join('、') : '无'}
            </Space>
          ))}
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={15}>
          <Card title="保洁任务" style={{ marginBottom: 16 }} extra={
            <Popconfirm title="按入住时间/脏污/维修/布草自动排班？" onConfirm={autoSchedule}>
              <Button type="primary">智能排班</Button>
            </Popconfirm>
          }>
            <Table dataSource={tasks} rowKey="id" size="small" pagination={{ pageSize: 8 }} columns={[
              { title: '房间', dataIndex: ['room', 'code'], width: 70,
                render: (v, r) => (
                  <div>{v}
                    {r.room?.status === 'awaiting_linen' && <div><Tag color="volcano">待布草</Tag></div>}
                  </div>
                ) },
              { title: '日期', dataIndex: 'date', width: 100 },
              { title: '脏污', dataIndex: 'dirtiness', width: 70, render: (v) => <Tag color={v === 'heavy' ? 'red' : v === 'light' ? 'green' : 'orange'}>{DIRTINESS[v]}</Tag> },
              { title: '状态', dataIndex: 'status', width: 90, render: (v) => <Tag color={TASK_STATUS[v]?.color}>{TASK_STATUS[v]?.text}</Tag> },
              { title: '保洁员', dataIndex: ['assignee', 'name'], width: 90, render: (v) => v || '-' },
              { title: '计划开始', dataIndex: 'scheduledStart', width: 110, render: (v) => v ? dayjs(v).format('MM-DD HH:mm') : '-' },
              { title: '布草', dataIndex: 'linenUsed', width: 60, render: (v) => `${v}套` },
              { title: '操作', width: 260, render: (_, r) => (
                <Space wrap>
                  {r.status === 'pending' && (
                    <Select size="small" placeholder="派单" style={{ width: 110 }}
                      options={cleaners.map((c) => ({ value: c.id, label: c.name }))}
                      onChange={(v) => act(() => api.post(`/cleaning/tasks/${r.id}/assign`, { cleanerId: v }), '已派单')} />
                  )}
                  {['pending', 'assigned'].includes(r.status) && <a onClick={() => act(() => api.post(`/cleaning/tasks/${r.id}/start`), '已开始打扫')}>开始</a>}
                  {r.status === 'in_progress' && (
                    <Popconfirm title="确认完成？布草不足时房间将自动转为待布草" onConfirm={() => act(() => api.post(`/cleaning/tasks/${r.id}/complete`, { linenUsed: 1 }), '已完成')}>
                      <a>完成</a>
                    </Popconfirm>
                  )}
                  {r.status === 'done' && <a onClick={() => act(() => api.post(`/cleaning/tasks/${r.id}/inspect`), '已验收')}>验收</a>}
                </Space>
              ) },
            ]} />
          </Card>

          <Card title="待布草房间（布草缺口 / 预计到达 / 可调拨房间 / 客人等待）"
            extra={<Button size="small" onClick={() => setBlockOpen(true)}>登记布草缺口</Button>}>
            <Table dataSource={blocks} rowKey="id" size="small" pagination={false}
              locale={{ emptyText: '暂无待布草房间' }}
              expandable={{
                expandedRowRender: (b) => (
                  <div style={{ padding: '4px 8px' }}>
                    <Descriptions size="small" column={2} bordered items={[
                      { key: '1', label: '等待客人', children: b.booking ? `${b.booking.code} ${b.booking.guestName}（${b.booking.checkIn} 入住）` : '无关联订单' },
                      { key: '2', label: '等待时长', children: `${b.waitedMinutes} 分钟` },
                      { key: '3', label: '关联配送单', children: b.delivery ? `#${b.delivery.id}（${{ scheduled: '待送达', delayed: '已延迟', delivered: '已送达' }[b.delivery.status]}）` : '未关联' },
                      { key: '4', label: '备注', children: b.note || '-' },
                    ]} />
                    {b.compensations.length > 0 && (
                      <Table style={{ marginTop: 8 }} size="small" rowKey="id" dataSource={b.compensations} pagination={false}
                        columns={[
                          { title: '补偿', dataIndex: 'type', width: 110, render: (v) => <Tag color={LINEN_COMP_TYPES[v]?.color}>{LINEN_COMP_TYPES[v]?.text || v}</Tag> },
                          { title: '金额', dataIndex: 'amount', width: 90, render: (v) => `¥${v}` },
                          { title: '原因', dataIndex: 'reason' },
                        ]} />
                    )}
                  </div>
                ),
              }}
              columns={[
                { title: '房间', dataIndex: ['room', 'code'], width: 70 },
                { title: '状态', dataIndex: 'status', width: 90, render: (v) => <Tag color={BLOCK_STATUS[v]?.color}>{BLOCK_STATUS[v]?.text}</Tag> },
                { title: '缺口', width: 110, render: (_, r) => `${r.item} ${r.shortage}套` },
                { title: '预计到达', dataIndex: 'expectedAt', width: 130, render: (v) => dayjs(v).format('MM-DD HH:mm') },
                { title: '客人', width: 100, render: (_, r) => r.booking?.guestName || '-' },
                { title: '已等待', dataIndex: 'waitedMinutes', width: 80, render: (v) => `${v}分` },
                { title: '可调拨房间', width: 110, render: (_, r) => r.transferRooms.length
                  ? r.transferRooms.map((x) => <Tag key={x.id} color="cyan">{x.code}</Tag>) : <Tag>无</Tag> },
                { title: '已补偿', dataIndex: 'compensationTotal', width: 80, render: (v) => v > 0 ? `¥${v}` : '-' },
                { title: '管家操作', width: 220, render: (_, r) => r.status === 'active' && (
                  <Space wrap>
                    <a onClick={() => { setCompTarget(r); compForm.resetFields(); }}>下午茶/补偿</a>
                    <a onClick={() => { setChangeTarget(r); changeForm.resetFields(); }}>换房</a>
                  </Space>
                ) },
              ]} />
            <div style={{ marginTop: 8, color: '#999', fontSize: 12 }}>
              布草到达后在下方「送洗配送」中签收，房态将自动从待布草转为可入住（已验收），待客补偿计入当日运营成本。
            </div>
          </Card>
        </Col>

        <Col xs={24} lg={9}>
          <Card title={`今日运营成本（${dayjs().format('MM-DD')}）`} style={{ marginBottom: 16 }}>
            {opsCost && (
              <Row gutter={8}>
                <Col span={12}><Statistic title="布草延迟待客补偿" value={opsCost.linenGuestCompensation} prefix="¥"
                  valueStyle={{ color: opsCost.linenGuestCompensation > 0 ? '#cf1322' : '#2f6b4f' }} /></Col>
                <Col span={12}><Statistic title="履约事件成本" value={opsCost.incidentCost} prefix="¥" /></Col>
                <Col span={12} style={{ marginTop: 8 }}><Statistic title="当日合计" value={opsCost.total} prefix="¥" /></Col>
                <Col span={12} style={{ marginTop: 8 }}><Statistic title="待布草房" value={opsCost.activeBlockCount} suffix="间" /></Col>
              </Row>
            )}
            {opsCost && Object.keys(opsCost.byType).length > 0 && (
              <div style={{ marginTop: 8 }}>
                {Object.entries(opsCost.byType).map(([t, v]) => (
                  <Tag key={t} color={LINEN_COMP_TYPES[t]?.color}>{LINEN_COMP_TYPES[t]?.text || t} ¥{v}</Tag>
                ))}
              </div>
            )}
          </Card>

          <Card title="布草库存" style={{ marginBottom: 16 }}>
            <Row gutter={8}>
              {stock.map((s) => (
                <Col span={12} key={s.item} style={{ marginBottom: 8 }}>
                  <Card size="small">
                    <Statistic title={s.item} value={s.available} suffix={`可用 / 共${s.total}`}
                      valueStyle={{ color: s.available < 10 || s.belowSafety ? '#cf1322' : '#2f6b4f' }} />
                    <div style={{ fontSize: 12, color: '#999' }}>
                      在用{s.inUse} · 待洗{s.inWash} · 破损{s.damaged} · 安全库存{s.safetyStock}
                    </div>
                    {s.belowSafety && <Tag color="red" style={{ marginTop: 2 }}>已触及安全库存线</Tag>}
                  </Card>
                </Col>
              ))}
            </Row>
          </Card>

          <Card title="送洗配送" extra={<Button size="small" onClick={() => setDeliveryOpen(true)}>预约送洗</Button>}>
            <Table dataSource={deliveries} rowKey="id" size="small" pagination={false} columns={[
              { title: '物品', dataIndex: 'item', width: 60 },
              { title: '数量', dataIndex: 'quantity', width: 60 },
              { title: '预计送达', dataIndex: 'expectedAt', render: (v) => dayjs(v).format('MM-DD HH:mm') },
              { title: '状态', dataIndex: 'status', width: 80, render: (v) => <Tag color={v === 'delayed' ? 'red' : v === 'delivered' ? 'green' : 'blue'}>{{ delayed: '延迟', delivered: '已送达', scheduled: '待送达' }[v]}</Tag> },
              { title: '原因', dataIndex: 'reason', width: 90, render: (v) => v || '-' },
              { title: '操作', width: 80, render: (_, r) => r.status === 'scheduled' && (
                <Popconfirm title="确认签收？关联待布草房将自动转为可入住；超时2小时另记布草延迟" onConfirm={() => act(() => api.post(`/linen/deliveries/${r.id}/arrive`), '已签收，房态已自动更新')}>
                  <a>签收</a>
                </Popconfirm>
              ) },
            ]} />
          </Card>
        </Col>
      </Row>

      {advice && advice.advices.length > 0 && (
        <Card title="布草延迟复盘与平台建议（多次出现时触发）" style={{ marginTop: 16 }}>
          <Space style={{ marginBottom: 12 }} wrap>
            <Tag color="red">延迟 {advice.delayedCount}/{advice.deliveryCount} 次（{advice.delayRate}%）</Tag>
            <Tag color="orange">待布草房 {advice.blockCount} 间次</Tag>
            <Tag color="gold">客人累计等待 {advice.totalWaitMinutes} 分钟</Tag>
            <Tag color="volcano">待客补偿 ¥{advice.guestCompensation}</Tag>
          </Space>
          {advice.advices.map((a) => (
            <Alert
              key={a.type}
              style={{ marginBottom: 12 }}
              type={a.type === 'peak_limit' ? 'warning' : 'error'}
              showIcon
              message={<b>{a.title}</b>}
              description={
                <div>
                  <div>{a.evidence}</div>
                  <div style={{ color: '#888', margin: '4px 0' }}>建议：{a.suggestion}</div>
                  {a.type === 'safety_stock' && (
                    <Space wrap>
                      <Popconfirm title="按建议上调各类布草安全库存？"
                        disabled={!advice.stockAdvice.some((s) => s.needRaise)}
                        onConfirm={async () => {
                          const payload = advice.stockAdvice.filter((s) => s.needRaise)
                            .map((s) => ({ item: s.item, safetyStock: s.suggestedSafety }));
                          await act(() => api.post('/analytics/linen-action', { type: 'safety_stock', items: payload }), '安全库存已上调');
                        }}>
                        <Button size="small" type="primary"
                          disabled={!advice.stockAdvice.some((s) => s.needRaise)}>
                          {advice.stockAdvice.some((s) => s.needRaise) ? '一键上调安全库存' : '安全库存已达标'}
                        </Button>
                      </Popconfirm>
                      <span style={{ fontSize: 12, color: '#999' }}>
                        {advice.stockAdvice.map((s) => `${s.item} ${s.currentSafety}→${s.suggestedSafety}`).join('；')}
                      </span>
                    </Space>
                  )}
                  {a.type === 'supplier' && (
                    <SupplierAction candidates={a.candidates} onDone={load} />
                  )}
                  {a.type === 'peak_limit' && (
                    <PeakLimitAction onDone={load} />
                  )}
                </div>
              }
            />
          ))}
          {advice.actions.length > 0 && (
            <div style={{ fontSize: 12, color: '#999' }}>
              已执行处置：{advice.actions.map((x) => dayjs(x.createdAt).format('MM-DD HH:mm') + ' ' + x.detail).join(' ｜ ')}
            </div>
          )}
        </Card>
      )}

      <Modal title="智能排班方案" open={!!plan} onCancel={() => setPlan(null)} footer={null} width={720}>
        {plan && (
          <>
            <Descriptions size="small" column={2} style={{ marginBottom: 12 }}
              items={[
                { key: '1', label: '排班日期', children: plan.date },
                { key: '2', label: '布草最少可用', children: `${plan.linenAvailable} 件` },
              ]} />
            <Timeline items={plan.plan.map((p) => ({
              color: p.warnings.length ? 'red' : 'green',
              children: (
                <div>
                  <b>{dayjs(p.start).format('HH:mm')}</b> · {p.room} 房 · {p.cleaner} · {DIRTINESS[p.dirtiness]}（约{p.durationMin}分钟）
                  {p.deadline && <Tag style={{ marginLeft: 8 }} color="orange">需 {dayjs(p.deadline).format('MM-DD HH:mm')} 前完成</Tag>}
                  {p.warnings.map((w, i) => <div key={i} style={{ color: '#cf1322', fontSize: 12 }}>⚠ {w}</div>)}
                </div>
              ),
            }))} />
          </>
        )}
      </Modal>

      <Modal title="预约布草送洗" open={deliveryOpen} onCancel={() => setDeliveryOpen(false)} okText="预约"
        onOk={async () => {
          await api.post('/linen/deliveries', { ...newDelivery, expectedAt: newDelivery.expectedAt.toISOString() });
          message.success('已预约'); setDeliveryOpen(false); load();
        }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Select value={newDelivery.item} style={{ width: '100%' }}
            options={['床单', '被套', '毛巾', '枕套'].map((i) => ({ value: i, label: i }))}
            onChange={(v) => setNewDelivery((s) => ({ ...s, item: v }))} />
          <InputNumber value={newDelivery.quantity} min={1} style={{ width: '100%' }} addonBefore="数量"
            onChange={(v) => setNewDelivery((s) => ({ ...s, quantity: v }))} />
          <DatePicker showTime value={newDelivery.expectedAt} style={{ width: '100%' }}
            onChange={(v) => setNewDelivery((s) => ({ ...s, expectedAt: v }))} />
          <Input addonBefore="延迟原因" value={newDelivery.reason}
            onChange={(e) => setNewDelivery((s) => ({ ...s, reason: e.target.value }))} placeholder="如：山路堵车" />
          <Input addonBefore="供应商" value={newDelivery.supplier}
            onChange={(e) => setNewDelivery((s) => ({ ...s, supplier: e.target.value }))} />
        </Space>
      </Modal>

      <Modal title="登记布草缺口（房间转待布草，自动生成布草延迟事件）" open={blockOpen}
        onCancel={() => setBlockOpen(false)} onOk={() => blockForm.submit()} okText="登记" destroyOnClose>
        <Form form={blockForm} layout="vertical"
          initialValues={{ roomId: undefined, bookingId: undefined, item: '床单', shortage: 1,
            expectedAt: dayjs('2026-10-03T16:00:00'), waitMinutes: 120 }}
          onFinish={async (v) => {
            await api.post('/linen/blocks', {
              ...v,
              expectedAt: v.expectedAt.toISOString(),
            });
            message.success('已登记待布草，可调拨房间已自动匹配');
            setBlockOpen(false); load();
          }}>
          <Form.Item name="roomId" label="房间" rules={[{ required: true }]}>
            <Select showSearch optionFilterProp="label"
              options={rooms.map((r) => ({ value: r.id, label: `${r.code} ${r.roomType.name}` }))} />
          </Form.Item>
          <Form.Item name="bookingId" label="等待入住订单（可选，用于匹配可调拨房间）">
            <Select allowClear showSearch optionFilterProp="label"
              options={bookings.map((b) => ({ value: b.id, label: `${b.code} ${b.guestName}（${b.room.code}房）` }))} />
          </Form.Item>
          <Space>
            <Form.Item name="item" label="缺口布草">
              <Select style={{ width: 140 }} options={['床单', '被套', '毛巾', '枕套', '整套布草'].map((i) => ({ value: i, label: i }))} />
            </Form.Item>
            <Form.Item name="shortage" label="缺口套数">
              <InputNumber min={1} />
            </Form.Item>
            <Form.Item name="waitMinutes" label="预计等待(分)">
              <InputNumber min={0} />
            </Form.Item>
          </Space>
          <Form.Item name="expectedAt" label="布草预计到达" rules={[{ required: true }]}>
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={compTarget ? `待客补偿：${compTarget.room.code} 房 · ${compTarget.booking?.guestName || '待定客人'}` : ''}
        open={!!compTarget} onCancel={() => setCompTarget(null)} onOk={() => compForm.submit()} okText="发放" destroyOnClose>
        <Form form={compForm} layout="vertical" initialValues={{ type: 'afternoon_tea', amount: 68 }}
          onFinish={async (v) => {
            await act(() => api.post(`/linen/blocks/${compTarget.id}/compensate`, v), '补偿已发放，计入当日运营成本');
            setCompTarget(null);
          }}>
          <Form.Item name="type" label="补偿方式" rules={[{ required: true }]}>
            <Select options={[
              { value: 'afternoon_tea', label: '免费下午茶' },
              { value: 'late_checkin', label: '延迟入住补偿（现金/抵扣）' },
            ]} />
          </Form.Item>
          <Form.Item name="amount" label="成本金额（¥）" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="note" label="说明"><Input placeholder="如：大堂茶座 3 位" /></Form.Item>
        </Form>
      </Modal>

      <Modal title={changeTarget ? `换房调拨：${changeTarget.room.code} 房客人` : ''}
        open={!!changeTarget} onCancel={() => setChangeTarget(null)} onOk={() => changeForm.submit()} okText="确认换房" destroyOnClose>
        <Form form={changeForm} layout="vertical" initialValues={{ amount: 0 }}
          onFinish={async (v) => {
            await act(() => api.post(`/linen/blocks/${changeTarget.id}/room-change`, v), '已换房，原房继续等待布草');
            setChangeTarget(null);
          }}>
          <Form.Item name="targetRoomId" label="调入房间（仅同房型当前可交付的空房）" rules={[{ required: true }]}>
            <Select options={(changeTarget?.transferRooms || []).map((r) => ({
              value: r.id, label: `${r.code} ${r.typeName}（${{ clean: '已清洁', inspected: '已验收' }[r.status]}）`,
            }))} />
          </Form.Item>
          <Form.Item name="amount" label="换房/升级成本（¥，可填0）">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="note" label="说明"><Input placeholder="如：免费升级安排" /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

function SupplierAction({ candidates, onDone }) {
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>记录更换/备用供应商</Button>
      <Modal title="调整洗涤供应商" open={open} onCancel={() => setOpen(false)}
        onOk={() => form.submit()} okText="保存" destroyOnClose>
        <Form form={form} layout="vertical" initialValues={{ supplier: candidates?.[0] || '' }}
          onFinish={async (v) => {
            await api.post('/analytics/linen-action', { type: 'supplier', supplier: v.supplier });
            message.success('已记录供应商调整');
            setOpen(false); onDone();
          }}>
          <Form.Item name="supplier" label="新/备用供应商" rules={[{ required: true }]}>
            <Select showSearch options={(candidates || []).map((c) => ({ value: c, label: c }))} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function PeakLimitAction({ onDone }) {
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  return (
    <>
      <Button size="small" type="primary" ghost onClick={() => setOpen(true)}>限制高峰连住订单</Button>
      <Modal title="限制高峰连住（每房型保留 1 间布草周转缓冲房）" open={open} onCancel={() => setOpen(false)}
        onOk={() => form.submit()} okText="应用" destroyOnClose>
        <Form form={form} layout="vertical"
          initialValues={{ range: [dayjs('2026-10-04'), dayjs('2026-10-05')] }}
          onFinish={async (v) => {
            await api.post('/analytics/linen-action', {
              type: 'peak_limit',
              from: v.range[0].format('YYYY-MM-DD'), to: v.range[1].format('YYYY-MM-DD'),
            });
            message.success('高峰可售房量已下调');
            setOpen(false); onDone();
          }}>
          <Form.Item name="range" label="高峰日期区间" rules={[{ required: true }]}>
            <DatePicker.RangePicker allowClear={false} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
