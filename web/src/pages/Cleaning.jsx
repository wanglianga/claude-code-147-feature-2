import React, { useEffect, useState } from 'react';
import {
  Alert, Button, Card, Col, DatePicker, Descriptions, InputNumber, Modal, Popconfirm, Radio,
  Row, Select, Space, Statistic, Table, Tag, Timeline, message,
} from 'antd';
import dayjs from 'dayjs';
import api, { TASK_STATUS, DIRTINESS, SHORTAGE_STATUS } from '../api';

export default function Cleaning() {
  const [tasks, setTasks] = useState([]);
  const [stock, setStock] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [cleaners, setCleaners] = useState([]);
  const [plan, setPlan] = useState(null);
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [newDelivery, setNewDelivery] = useState({ item: '床单', quantity: 20, expectedAt: dayjs('2026-10-05T09:00:00') });
  const [shortages, setShortages] = useState([]);
  const [advice, setAdvice] = useState(null);
  const [relocateTarget, setRelocateTarget] = useState(null);
  const [alternatives, setAlternatives] = useState([]);
  const [altRoomId, setAltRoomId] = useState(null);
  const [compTarget, setCompTarget] = useState(null);
  const [compAmount, setCompAmount] = useState(200);

  const load = async () => {
    const [t, s, d, u, sh, adv] = await Promise.all([
      api.get('/cleaning/tasks'),
      api.get('/linen/stock'),
      api.get('/linen/deliveries'),
      api.get('/auth/users').catch(() => []),
      api.get('/linen/shortages'),
      api.get('/linen/delay-advice'),
    ]);
    setTasks(t); setStock(s); setDeliveries(d); setShortages(sh); setAdvice(adv);
    setCleaners(u.filter((x) => x.role === 'cleaner'));
  };
  useEffect(() => { load(); }, []);

  const act = async (fn, ok) => { await fn(); message.success(ok); load(); };

  const autoSchedule = async () => {
    const r = await api.post('/cleaning/auto-schedule', {});
    setPlan(r);
    load();
  };

  const openRelocate = async (s) => {
    const r = await api.get(`/linen/shortages/${s.id}/alternatives`);
    setAlternatives(r.rooms);
    setAltRoomId(r.rooms[0]?.roomId || null);
    setRelocateTarget(s);
  };

  const waitingCount = shortages.filter((s) => s.status === 'waiting').length;

  return (
    <div>
      {advice && advice.suggestions.length > 0 && (
        <Alert style={{ marginBottom: 16 }} type="warning" showIcon
          message={`布草延迟已发生 ${advice.delayCount} 起（配送延迟率 ${advice.deliveries.delayRate}%），平台建议：`}
          description={(
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {advice.suggestions.map((s) => (
                <li key={s.type}><b>{s.title}</b>：{s.evidence}。{s.suggestion}</li>
              ))}
            </ul>
          )} />
      )}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={15}>
          <Card title="保洁任务" extra={
            <Popconfirm title="按入住时间/脏污/维修/布草自动排班？" onConfirm={autoSchedule}>
              <Button type="primary">智能排班</Button>
            </Popconfirm>
          }>
            <Table dataSource={tasks} rowKey="id" size="small" pagination={{ pageSize: 10 }} columns={[
              { title: '房间', dataIndex: ['room', 'code'], width: 70 },
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
                    <Popconfirm title="确认完成？消耗 1 套布草" onConfirm={() => act(() => api.post(`/cleaning/tasks/${r.id}/complete`, { linenUsed: 1 }), '已完成，布草已计入待洗')}>
                      <a>完成</a>
                    </Popconfirm>
                  )}
                  {r.status === 'done' && <a onClick={() => act(() => api.post(`/cleaning/tasks/${r.id}/inspect`), '已验收')}>验收</a>}
                </Space>
              ) },
            ]} />
          </Card>
        </Col>
        <Col xs={24} lg={9}>
          <Card title="布草库存" style={{ marginBottom: 16 }}>
            <Row gutter={8}>
              {stock.map((s) => (
                <Col span={12} key={s.item} style={{ marginBottom: 8 }}>
                  <Card size="small">
                    <Statistic title={s.item} value={s.available} suffix={`可用 / 共${s.total}`}
                      valueStyle={{ color: s.available < 10 ? '#cf1322' : '#2f6b4f' }} />
                    <div style={{ fontSize: 12, color: '#999' }}>在用{s.inUse} · 待洗{s.inWash} · 破损{s.damaged}</div>
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
              { title: '操作', width: 110, render: (_, r) => r.status === 'scheduled' && (
                <Popconfirm title="确认签收？超时2小时记布草延迟；等待该布草的房间将自动恢复可入住"
                  onConfirm={() => act(() => api.post(`/linen/deliveries/${r.id}/arrive`), '已签收，待布草房间已自动恢复可入住')}>
                  <a>签收</a>
                </Popconfirm>
              ) },
            ]} />
          </Card>
        </Col>
      </Row>

      <Card style={{ marginTop: 16 }}
        title={`布草缺口 · 待布草房间（保洁完成但布草未到，无法按时交付）${waitingCount ? `：${waitingCount} 间等待中` : ''}`}>
        <Table dataSource={shortages} rowKey="id" size="small" pagination={false} columns={[
          { title: '房间', dataIndex: 'roomCode', width: 70, render: (v) => <b>{v}</b> },
          { title: '等待客人', width: 130, render: (_, r) => r.guestName ? `${r.guestName}（${r.bookingCode}）` : '-' },
          { title: '缺口', width: 100, render: (_, r) => `${r.item}×${r.quantity}` },
          { title: '预计到达', dataIndex: 'expectedAt', width: 110, render: (v) => dayjs(v).format('MM-DD HH:mm') },
          { title: '已等待', dataIndex: 'waitingMinutes', width: 100, render: (v, r) => (
            <span style={{ color: r.status === 'waiting' && v >= 60 ? '#cf1322' : 'inherit', fontWeight: r.status === 'waiting' ? 700 : 400 }}>
              {v >= 60 ? `${Math.floor(v / 60)}小时${v % 60 ? `${v % 60}分` : ''}` : `${v}分钟`}
            </span>
          ) },
          { title: '状态', dataIndex: 'status', width: 100, render: (v) => <Tag color={SHORTAGE_STATUS[v]?.color}>{SHORTAGE_STATUS[v]?.text}</Tag> },
          { title: '处理', dataIndex: 'resolution', render: (v) => v || '-' },
          { title: '管家处置', width: 250, render: (_, r) => r.status === 'waiting' && (
            <Space wrap>
              <Popconfirm title="为等待客人提供下午茶安抚？（¥68 计入当日运营成本）"
                onConfirm={() => act(() => api.post(`/linen/shortages/${r.id}/compensate`, { action: 'afternoon_tea', amount: 68 }), '已安排下午茶，费用计入当日运营成本')}>
                <a>下午茶</a>
              </Popconfirm>
              <a onClick={() => { setCompTarget(r); setCompAmount(200); }}>延迟入住补偿</a>
              <a onClick={() => openRelocate(r)}>调拨换房</a>
            </Space>
          ) },
        ]} />
      </Card>

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
        </Space>
      </Modal>

      <Modal title={compTarget ? `延迟入住补偿：${compTarget.guestName}（${compTarget.roomCode}房，已等待${compTarget.waitingMinutes}分钟）` : ''}
        open={!!compTarget} onCancel={() => setCompTarget(null)} okText="发放补偿"
        onOk={async () => {
          await act(() => api.post(`/linen/shortages/${compTarget.id}/compensate`, { action: 'late_checkin', amount: compAmount }), '补偿已发放，计入当日运营成本');
          setCompTarget(null);
        }}>
        <p style={{ color: '#888' }}>布草延迟导致客人无法按时入住，补偿金额将计入当日运营成本。</p>
        <InputNumber value={compAmount} min={1} style={{ width: '100%' }} addonBefore="补偿金额（¥）"
          onChange={(v) => setCompAmount(v)} />
      </Modal>

      <Modal title={relocateTarget ? `调拨换房：${relocateTarget.guestName}（${relocateTarget.roomCode} → ?）` : ''}
        open={!!relocateTarget} onCancel={() => setRelocateTarget(null)} okText="确认调拨"
        okButtonProps={{ disabled: !altRoomId }}
        onOk={async () => {
          await act(() => api.post(`/linen/shortages/${relocateTarget.id}/compensate`, { action: 'room_change', toRoomId: altRoomId }), '已调拨换房，客人可先行入住');
          setRelocateTarget(null);
        }}>
        <p style={{ color: '#888' }}>可调拨房间（已清洁/已验收且住期内无冲突，同房型优先）：</p>
        <Radio.Group value={altRoomId} onChange={(e) => setAltRoomId(e.target.value)}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {alternatives.map((r) => (
            <Radio key={r.roomId} value={r.roomId}>
              {r.code} · {r.typeName}{r.sameType ? '（同房型）' : ''} · 门市价 ¥{r.basePrice}/晚
            </Radio>
          ))}
          {!alternatives.length && <span style={{ color: '#cf1322' }}>暂无可调拨房间，可考虑补偿方案</span>}
        </Radio.Group>
      </Modal>
    </div>
  );
}
