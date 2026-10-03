import React, { useEffect, useState } from 'react';
import {
  Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Select, Space,
  Table, Tabs, Tag, message,
} from 'antd';
import dayjs from 'dayjs';
import api, { INCIDENT_TYPES, INCIDENT_STATUS, REVIEW_CATEGORIES, COMP_TYPES } from '../api';

export default function Incidents() {
  const [incidents, setIncidents] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [compensations, setCompensations] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [compTarget, setCompTarget] = useState(null);
  const [form] = Form.useForm();
  const [compForm] = Form.useForm();

  const load = async () => {
    const [i, r, c, b, rm] = await Promise.all([
      api.get('/incidents'), api.get('/reviews'), api.get('/compensations'),
      api.get('/bookings'), api.get('/rooms'),
    ]);
    setIncidents(i); setReviews(r); setCompensations(c); setBookings(b); setRooms(rm);
  };
  useEffect(() => { load(); }, []);

  const act = async (fn, ok) => { await fn(); message.success(ok); load(); };

  return (
    <Card>
      <Tabs items={[
        {
          key: 'incidents',
          label: `住宿链路事件 (${incidents.filter((i) => i.status === 'open').length} 待处理)`,
          children: (
            <>
              <Space style={{ marginBottom: 12 }}>
                <Button type="primary" onClick={() => setCreateOpen(true)}>登记事件</Button>
              </Space>
              <Table dataSource={incidents} rowKey="id" size="middle" pagination={{ pageSize: 10 }} columns={[
                { title: '时间', dataIndex: 'occurredAt', width: 110, render: (v) => dayjs(v).format('MM-DD HH:mm') },
                { title: '类型', dataIndex: 'type', width: 100, render: (v) => <Tag color={v === 'oversell' || v === 'bad_review' ? 'red' : 'orange'}>{INCIDENT_TYPES[v] || v}</Tag> },
                { title: '描述', dataIndex: 'description' },
                { title: '订单', dataIndex: 'bookingId', width: 80, render: (v) => v ? `#${v}` : '-' },
                { title: '成本', dataIndex: 'cost', width: 80, render: (v) => v > 0 ? `¥${v}` : '-' },
                { title: '状态', dataIndex: 'status', width: 90, render: (v) => <Tag color={INCIDENT_STATUS[v]?.color}>{INCIDENT_STATUS[v]?.text}</Tag> },
                { title: '处理', dataIndex: 'resolution', width: 180, render: (v) => v || '-' },
                { title: '操作', width: 90, render: (_, r) => r.status !== 'resolved' && (
                  <a onClick={async () => {
                    const resolution = window.prompt('处理结果说明');
                    if (resolution) await act(() => api.post(`/incidents/${r.id}/resolve`, { resolution }), '已解决');
                  }}>标记解决</a>
                ) },
              ]} />
            </>
          ),
        },
        {
          key: 'reviews',
          label: `差评与补偿 (${reviews.filter((r) => r.rating <= 3 && !r.compensated).length} 待补偿)`,
          children: (
            <Table dataSource={reviews} rowKey="id" pagination={false} columns={[
              { title: '订单', dataIndex: 'bookingCode', width: 100 },
              { title: '客人', dataIndex: 'guestName', width: 100 },
              { title: '渠道', dataIndex: 'channel', width: 90 },
              { title: '评分', dataIndex: 'rating', width: 80, render: (v) => <span style={{ color: v <= 3 ? '#cf1322' : '#2f6b4f', fontWeight: 700 }}>{v}分</span> },
              { title: '归因', dataIndex: 'category', width: 90, render: (v) => <Tag color={{ hardware: 'volcano', service: 'gold', oversell: 'red', food: 'purple' }[v]}>{REVIEW_CATEGORIES[v]}</Tag> },
              { title: '内容', dataIndex: 'content' },
              { title: '补偿', dataIndex: 'compensated', width: 100, render: (v) => v ? <Tag color="green">已补偿</Tag> : <Tag color="red">未补偿</Tag> },
              { title: '操作', width: 100, render: (_, r) => !r.compensated && r.rating <= 3 && (
                <Button size="small" type="primary" onClick={() => { setCompTarget(r); compForm.resetFields(); }}>发放补偿</Button>
              ) },
            ]} />
          ),
        },
        {
          key: 'compensations',
          label: '补偿记录',
          children: (
            <Table dataSource={compensations} rowKey="id" pagination={false} columns={[
              { title: '时间', dataIndex: 'createdAt', width: 150, render: (v) => dayjs(v).format('MM-DD HH:mm') },
              { title: '类型', dataIndex: 'type', width: 110, render: (v) => <Tag>{COMP_TYPES[v] || v}</Tag> },
              { title: '金额', dataIndex: 'amount', width: 90, render: (v) => `¥${v}` },
              { title: '券码', dataIndex: 'voucherCode', width: 120, render: (v) => v || '-' },
              { title: '订单', dataIndex: 'bookingId', width: 80, render: (v) => v ? `#${v}` : '-' },
              { title: '原因', dataIndex: 'reason' },
              { title: '状态', dataIndex: 'status', width: 90, render: (v) => <Tag color={v === 'used' ? 'green' : v === 'issued' ? 'blue' : 'default'}>{{ issued: '已发放', used: '已核销', cancelled: '已作废' }[v]}</Tag> },
              { title: '操作', width: 90, render: (_, r) => r.type === 'voucher' && r.status === 'issued' && (
                <Popconfirm title="确认核销该补偿券？" onConfirm={() => act(() => api.post(`/compensations/${r.id}/use`), '已核销')}>
                  <a>核销</a>
                </Popconfirm>
              ) },
            ]} />
          ),
        },
      ]} />

      <Modal title="登记事件（宠物损坏自动扣押金+建维修单；空调故障自动转房态）" open={createOpen}
        onCancel={() => setCreateOpen(false)} onOk={() => form.submit()} okText="登记" destroyOnClose>
        <Form form={form} layout="vertical" onFinish={async (v) => {
          await api.post('/incidents', v);
          message.success('事件已登记');
          setCreateOpen(false); load();
        }}>
          <Form.Item name="type" label="事件类型" rules={[{ required: true }]}>
            <Select options={Object.entries(INCIDENT_TYPES).filter(([k]) => !['bad_review', 'oversell'].includes(k))
              .map(([v, l]) => ({ value: v, label: l }))} />
          </Form.Item>
          <Form.Item name="bookingId" label="关联订单（可选）">
            <Select allowClear showSearch optionFilterProp="label"
              options={bookings.map((b) => ({ value: b.id, label: `${b.code} ${b.guestName}（${b.room.code}房）` }))} />
          </Form.Item>
          <Form.Item name="roomId" label="关联房间（可选）">
            <Select allowClear options={rooms.map((r) => ({ value: r.id, label: r.code }))} />
          </Form.Item>
          <Form.Item name="description" label="描述" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="cost" label="损失/成本（¥，宠物损坏将从押金扣除）" initialValue={0}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={compTarget ? `补偿差评：${compTarget.guestName}（${compTarget.rating}分/${REVIEW_CATEGORIES[compTarget.category]}）` : ''}
        open={!!compTarget} onCancel={() => setCompTarget(null)} onOk={() => compForm.submit()} okText="发放补偿" destroyOnClose>
        <Form form={compForm} layout="vertical" initialValues={{ type: 'voucher', amount: 100 }}
          onFinish={async (v) => {
            await api.post(`/compensations/for-review/${compTarget.id}`, v);
            message.success('补偿已发放，差评事件已关闭');
            setCompTarget(null); load();
          }}>
          <Form.Item name="type" label="补偿方式" rules={[{ required: true }]}>
            <Select options={[{ value: 'voucher', label: '补偿券（自动生成券码）' }, { value: 'cash', label: '现金' }, { value: 'refund', label: '房费退款' }]} />
          </Form.Item>
          <Form.Item name="amount" label="金额（¥）" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="reason" label="补偿原因">
            <Input placeholder="默认：差评补偿" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
