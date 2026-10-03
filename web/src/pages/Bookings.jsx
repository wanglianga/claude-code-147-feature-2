import React, { useEffect, useState } from 'react';
import {
  Button, Card, Checkbox, DatePicker, Descriptions, Drawer, Form, Input, InputNumber,
  Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Timeline, message,
} from 'antd';
import dayjs from 'dayjs';
import api, { BOOKING_STATUS, INCIDENT_TYPES, INCIDENT_STATUS, TASK_STATUS, DIRTINESS, REVIEW_CATEGORIES, LINEN_COMP_TYPES } from '../api';

export default function Bookings() {
  const [list, setList] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [filter, setFilter] = useState({});
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const [b, r, c] = await Promise.all([
        api.get('/bookings', { params: filter }),
        api.get('/rooms'),
        api.get('/channels'),
      ]);
      setList(b); setRooms(r); setChannels(c);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [filter]);

  const openDetail = async (id) => setDetail(await api.get(`/bookings/${id}`));
  const refresh = async () => { await load(); if (detail) await openDetail(detail.id); };

  const create = async (values) => {
    await api.post('/bookings', {
      ...values,
      checkIn: values.range[0].format('YYYY-MM-DD'),
      checkOut: values.range[1].format('YYYY-MM-DD'),
      range: undefined,
    });
    message.success('订单创建成功');
    setCreateOpen(false);
    form.resetFields();
    load();
  };

  const act = async (fn, ok) => { await fn(); message.success(ok); refresh(); };

  const columns = [
    { title: '订单号', dataIndex: 'code', width: 100 },
    { title: '客人', dataIndex: 'guestName', width: 110 },
    { title: '渠道', dataIndex: ['channel', 'name'], width: 90 },
    { title: '房间', width: 130, render: (_, r) => (
      <span>
        {r.room.code} {r.roomType.name}
        {r.room.status === 'awaiting_linen' && <Tag color="volcano" style={{ marginLeft: 4 }}>待布草</Tag>}
      </span>
    ) },
    { title: '入住', dataIndex: 'checkIn', width: 105 },
    { title: '离店', dataIndex: 'checkOut', width: 105 },
    { title: '人数', width: 90, render: (_, r) => `${r.adults}大${r.children}小${r.extraBeds ? ` +${r.extraBeds}床` : ''}${r.pets ? ` 🐾${r.pets}` : ''}` },
    { title: '早餐', dataIndex: 'breakfastCount', width: 60, render: (v) => `${v}份` },
    { title: '总额', dataIndex: 'totalAmount', width: 90, render: (v) => `¥${v}` },
    { title: '状态', dataIndex: 'status', width: 90, render: (v) => <Tag color={BOOKING_STATUS[v]?.color}>{BOOKING_STATUS[v]?.text}</Tag> },
    { title: '操作', width: 230, render: (_, r) => (
      <Space wrap>
        <a onClick={() => openDetail(r.id)}>详情</a>
        {r.status === 'booked' && <a onClick={() => act(() => api.post(`/bookings/${r.id}/check-in`), '已办理入住')}>入住</a>}
        {r.status === 'checked_in' && (
          <Popconfirm title="确认退房？将生成保洁任务" onConfirm={() => act(() => api.post(`/bookings/${r.id}/check-out`, {}), '已退房，保洁任务已生成')}>
            <a>退房</a>
          </Popconfirm>
        )}
        {r.status === 'booked' && (
          <Popconfirm title="确认取消该订单？" onConfirm={() => act(() => api.post(`/bookings/${r.id}/cancel`), '已取消')}>
            <a style={{ color: '#cf1322' }}>取消</a>
          </Popconfirm>
        )}
      </Space>
    ) },
  ];

  return (
    <Card title="订单管理" extra={
      <Space>
        <Select allowClear placeholder="状态" style={{ width: 110 }}
          options={Object.entries(BOOKING_STATUS).map(([v, s]) => ({ value: v, label: s.text }))}
          onChange={(v) => setFilter((f) => ({ ...f, status: v }))} />
        <Select allowClear placeholder="渠道" style={{ width: 120 }}
          options={channels.map((c) => ({ value: c.id, label: c.name }))}
          onChange={(v) => setFilter((f) => ({ ...f, channelId: v }))} />
        <Button type="primary" onClick={() => setCreateOpen(true)}>新建订单</Button>
      </Space>
    }>
      <Table dataSource={list} columns={columns} rowKey="id" loading={loading} size="middle"
        scroll={{ x: 1200 }} pagination={{ pageSize: 12 }} />

      <Modal title="新建订单（统一房态/价格/规则校验）" open={createOpen} onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()} width={640} okText="创建">
        <Form form={form} layout="vertical" onFinish={create}
          initialValues={{ adults: 2, children: 0, extraBeds: 0, pets: 0, breakfastCount: 2, range: [dayjs('2026-10-05'), dayjs('2026-10-06')] }}>
          <Space size={12} wrap>
            <Form.Item name="channelId" label="渠道" rules={[{ required: true }]} style={{ width: 150 }}>
              <Select options={channels.map((c) => ({ value: c.id, label: `${c.name}(佣金${(c.commissionRate * 100).toFixed(0)}%)` }))} />
            </Form.Item>
            <Form.Item name="roomId" label="房间" rules={[{ required: true }]} style={{ width: 220 }}>
              <Select showSearch optionFilterProp="label"
                options={rooms.map((r) => ({ value: r.id, label: `${r.code} ${r.roomType.name}（${r.roomType.petAllowed ? '可宠' : '禁宠'}/${r.roomType.extraBedAllowed ? '可加床' : '不可加床'}）` }))} />
            </Form.Item>
            <Form.Item name="range" label="入住-离店" rules={[{ required: true }]}>
              <DatePicker.RangePicker allowClear={false} />
            </Form.Item>
          </Space>
          <Space size={12} wrap>
            <Form.Item name="guestName" label="客人姓名" rules={[{ required: true }]} style={{ width: 140 }}><Input /></Form.Item>
            <Form.Item name="guestPhone" label="电话" style={{ width: 150 }}><Input /></Form.Item>
            <Form.Item name="adults" label="成人" style={{ width: 80 }}><InputNumber min={1} max={8} /></Form.Item>
            <Form.Item name="children" label="儿童" style={{ width: 80 }}><InputNumber min={0} max={4} /></Form.Item>
            <Form.Item name="extraBeds" label="加床" style={{ width: 80 }}><InputNumber min={0} max={2} /></Form.Item>
            <Form.Item name="pets" label="宠物" style={{ width: 80 }}><InputNumber min={0} max={2} /></Form.Item>
            <Form.Item name="breakfastCount" label="早餐份数/天" style={{ width: 110 }}><InputNumber min={0} max={8} /></Form.Item>
          </Space>
          <Space size={12} wrap>
            <Form.Item name="dietaryNotes" label="忌口" style={{ width: 220 }}><Input placeholder="如：不吃辣/素食/海鲜过敏" /></Form.Item>
            <Form.Item name="invoiceTitle" label="发票抬头（留空=不需要发票）" style={{ width: 260 }}><Input /></Form.Item>
            <Form.Item name="force" valuePropName="checked" label=" "><Checkbox>OTA强推/强制下单（允许突破可售）</Checkbox></Form.Item>
          </Space>
        </Form>
      </Modal>

      <Drawer title={detail ? `订单 ${detail.code} · 住宿全链路` : ''} open={!!detail} onClose={() => setDetail(null)} width={720}>
        {detail && <BookingDetail detail={detail} refresh={refresh} />}
      </Drawer>
    </Card>
  );
}

function BookingDetail({ detail, refresh }) {
  const [extraOpen, setExtraOpen] = useState(false);
  const [form] = Form.useForm();
  const s = detail.settlement;
  const act = async (fn, ok) => { await fn(); message.success(ok); refresh(); };

  return (
    <Tabs items={[
      {
        key: 'info', label: '订单信息',
        children: (
          <>
            <Descriptions column={2} size="small" bordered items={[
              { key: '1', label: '客人', children: `${detail.guestName} ${detail.guestPhone}` },
              { key: '2', label: '渠道', children: `${detail.channel.name}（佣金${(detail.channel.commissionRate * 100).toFixed(0)}%）` },
              { key: '3', label: '房间', children: `${detail.room.code} ${detail.roomType.name}` },
              { key: '4', label: '状态', children: <Tag color={BOOKING_STATUS[detail.status]?.color}>{BOOKING_STATUS[detail.status]?.text}</Tag> },
              { key: '5', label: '入离', children: `${detail.checkIn} ~ ${detail.checkOut}（${detail.nights}晚）` },
              { key: '6', label: '人数', children: `${detail.adults}大 ${detail.children}小 加床${detail.extraBeds} 宠物${detail.pets}` },
              { key: '7', label: '早餐', children: `${detail.breakfastCount}份/天 ${detail.dietaryNotes ? `（忌口：${detail.dietaryNotes}）` : ''}` },
              { key: '8', label: '发票', children: detail.invoiceRequired ? detail.invoiceTitle : '不需要' },
              { key: '9', label: '押金', children: `收¥${detail.depositAmount} 扣¥${detail.depositDeducted} 退¥${detail.depositReturned}` },
              { key: '10', label: '实际入离', children: `${detail.actualCheckIn ? dayjs(detail.actualCheckIn).format('MM-DD HH:mm') : '-'} ~ ${detail.actualCheckOut ? dayjs(detail.actualCheckOut).format('MM-DD HH:mm') : '-'}` },
            ]} />
            <Space style={{ marginTop: 16 }}>
              {detail.status !== 'cancelled' && detail.status !== 'checked_out' && (
                <Button onClick={() => setExtraOpen(true)}>临时加人</Button>
              )}
            </Space>
            <Modal title="临时加人（费用自动重算并记入事件链）" open={extraOpen} onCancel={() => setExtraOpen(false)}
              onOk={() => form.submit()} okText="确认变更">
              <Form form={form} layout="vertical" initialValues={{ adults: detail.adults, children: detail.children, breakfastCount: detail.breakfastCount }}
                onFinish={async (v) => { await act(() => api.post(`/bookings/${detail.id}/extra-guests`, v), '已变更'); setExtraOpen(false); }}>
                <Form.Item name="adults" label="成人"><InputNumber min={1} max={8} /></Form.Item>
                <Form.Item name="children" label="儿童"><InputNumber min={0} max={4} /></Form.Item>
                <Form.Item name="breakfastCount" label="早餐份数/天"><InputNumber min={0} max={8} /></Form.Item>
              </Form>
            </Modal>
          </>
        ),
      },
      {
        key: 'chain', label: `链路事件(${detail.incidents.length})`,
        children: detail.incidents.length ? (
          <Timeline items={detail.incidents.map((i) => ({
            color: i.status === 'resolved' ? 'green' : 'red',
            children: (
              <div>
                <Space>
                  <Tag color={INCIDENT_STATUS[i.status]?.color}>{INCIDENT_STATUS[i.status]?.text}</Tag>
                  <b>{INCIDENT_TYPES[i.type] || i.type}</b>
                  {i.cost > 0 && <Tag color="volcano">成本 ¥{i.cost}</Tag>}
                  <span style={{ color: '#999', fontSize: 12 }}>{dayjs(i.occurredAt).format('MM-DD HH:mm')}</span>
                </Space>
                <div style={{ marginTop: 4 }}>{i.description}</div>
                {i.resolution && <div style={{ color: '#389e0d', fontSize: 12, marginTop: 2 }}>处理：{i.resolution}</div>}
              </div>
            ),
          }))} />
        ) : '暂无事件',
      },
      {
        key: 'cleaning', label: '保洁',
        children: detail.cleaningTask ? (
          <Descriptions column={1} size="small" bordered items={[
            { key: '1', label: '任务状态', children: <Tag color={TASK_STATUS[detail.cleaningTask.status]?.color}>{TASK_STATUS[detail.cleaningTask.status]?.text}</Tag> },
            { key: '2', label: '脏污程度', children: DIRTINESS[detail.cleaningTask.dirtiness] },
            { key: '3', label: '保洁员', children: detail.cleaningTask.assignee?.name || '未派单' },
            { key: '4', label: '布草消耗', children: `${detail.cleaningTask.linenUsed} 套` },
          ]} />
        ) : '退房后自动生成保洁任务',
      },
      {
        key: 'review', label: '评价与补偿',
        children: (
          <>
            {detail.review ? (
              <Descriptions column={1} size="small" bordered items={[
                { key: '1', label: '评分', children: `${detail.review.rating} 分 ${detail.review.rating <= 3 ? '（差评）' : ''}` },
                { key: '2', label: '分类', children: REVIEW_CATEGORIES[detail.review.category] },
                { key: '3', label: '内容', children: detail.review.content },
                { key: '4', label: '补偿', children: detail.review.compensated ? '已补偿' : '未补偿' },
              ]} />
            ) : '暂无评价'}
            {detail.compensations.length > 0 && (
              <Table style={{ marginTop: 12 }} size="small" rowKey="id" dataSource={detail.compensations}
                pagination={false} columns={[
                  { title: '类型', dataIndex: 'type', render: (v) => LINEN_COMP_TYPES[v]?.text || { cash: '现金', voucher: '补偿券', refund: '退款' }[v] },
                  { title: '金额', dataIndex: 'amount', render: (v) => `¥${v}` },
                  { title: '券码', dataIndex: 'voucherCode', render: (v) => v || '-' },
                  { title: '状态', dataIndex: 'status', render: (v) => ({ issued: '已发放', used: '已核销', cancelled: '已作废' }[v]) },
                  { title: '原因', dataIndex: 'reason' },
                ]} />
            )}
          </>
        ),
      },
      {
        key: 'settlement', label: '结算明细',
        children: (
          <>
            <Table size="small" rowKey="label" dataSource={s.lines} pagination={false} columns={[
              { title: '项目', dataIndex: 'label' },
              { title: '金额', dataIndex: 'amount', align: 'right', render: (v) => <span style={{ color: v < 0 ? '#cf1322' : 'inherit' }}>¥{v.toFixed(2)}</span> },
            ]} />
            <Descriptions style={{ marginTop: 12 }} column={2} size="small" bordered items={[
              { key: '1', label: '应收合计', children: `¥${s.gross}` },
              { key: '2', label: `渠道佣金(${(s.commissionRate * 100).toFixed(0)}%)`, children: `-¥${s.commission}` },
              { key: '3', label: '补偿支出', children: `-¥${s.compensation}` },
              { key: '4', label: '押金扣款留存', children: `+¥${s.deposit.deducted}` },
              { key: '5', label: '净收入', children: <b style={{ color: '#2f6b4f' }}>¥{s.net}</b> },
              { key: '6', label: '押金', children: `收${s.deposit.collected} / 扣${s.deposit.deducted} / 退${s.deposit.returned}` },
            ]} />
          </>
        ),
      },
    ]} />
  );
}
