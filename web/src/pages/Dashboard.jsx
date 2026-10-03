import React, { useEffect, useState } from 'react';
import { Card, Col, DatePicker, Row, Statistic, Table, Tag } from 'antd';
import dayjs from 'dayjs';
import api, { INCIDENT_TYPES, REVIEW_CATEGORIES, COMP_TYPES } from '../api';
import Chart from '../components/Chart';

export default function Dashboard() {
  const [range, setRange] = useState([dayjs('2026-09-28'), dayjs('2026-10-08')]);
  const [data, setData] = useState(null);
  const [costDate, setCostDate] = useState(dayjs('2026-10-03'));
  const [dailyCosts, setDailyCosts] = useState(null);

  const load = async (r = range) => {
    const d = await api.get('/analytics/dashboard', {
      params: { from: r[0].format('YYYY-MM-DD'), to: r[1].format('YYYY-MM-DD') },
    });
    setData(d);
  };
  const loadCosts = async (d = costDate) => {
    setDailyCosts(await api.get('/analytics/daily-costs', { params: { date: d.format('YYYY-MM-DD') } }));
  };
  useEffect(() => { load(); loadCosts(); }, []);

  if (!data) return <Card loading />;
  const { kpi } = data;

  return (
    <div>
      <Card style={{ marginBottom: 16 }} styles={{ body: { paddingBottom: 8 } }}>
        <DatePicker.RangePicker value={range} onChange={(r) => { setRange(r); if (r?.[0]) load(r); }} allowClear={false} />
        <span style={{ marginLeft: 12, color: '#888' }}>旺季经营概览（国庆 10-01 ~ 10-07）</span>
      </Card>
      <Row gutter={[16, 16]}>
        {[
          { title: '入住率', value: kpi.occupancy, suffix: '%' },
          { title: '已售间夜', value: kpi.soldNights, suffix: `/${kpi.roomNightsAvailable}` },
          { title: '总收入(¥)', value: kpi.revenue },
          { title: 'ADR 平均房价(¥)', value: kpi.adr },
          { title: 'RevPAR(¥)', value: kpi.revpar },
          { title: '补偿成本(¥)', value: kpi.compensationCost },
          { title: '差评数', value: kpi.badReviewCount, suffix: `/${kpi.reviewCount}` },
          { title: '平均评分', value: kpi.avgRating },
        ].map((s) => (
          <Col xs={12} md={6} key={s.title}>
            <Card><Statistic title={s.title} value={s.value} suffix={s.suffix} precision={String(s.value).includes('.') ? 2 : 0} /></Card>
          </Col>
        ))}
      </Row>
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card title="每日入住率">
            <Chart option={{
              tooltip: { trigger: 'axis' },
              xAxis: { type: 'category', data: data.daily.map((d) => d.date.slice(5)) },
              yAxis: [{ type: 'value', name: '间夜' }, { type: 'value', name: '%', max: 100 }],
              series: [
                { name: '已售间夜', type: 'bar', data: data.daily.map((d) => d.sold), itemStyle: { color: '#2f6b4f' } },
                { name: '入住率', type: 'line', yAxisIndex: 1, data: data.daily.map((d) => d.occupancy), itemStyle: { color: '#d48806' } },
              ],
            }} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="渠道收入分布">
            <Chart option={{
              tooltip: { trigger: 'item', formatter: '{b}: ¥{c} ({d}%)' },
              series: [{ type: 'pie', radius: ['40%', '70%'], data: data.revenueByChannel,
                label: { formatter: '{b}\n¥{c}' } }],
            }} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="履约事件分布（延迟退房/超卖/布草/早餐/故障…）">
            <Chart option={{
              tooltip: {},
              xAxis: { type: 'category', data: data.incidentsByType.map((i) => INCIDENT_TYPES[i.type] || i.type), axisLabel: { rotate: 30 } },
              yAxis: { type: 'value', minInterval: 1 },
              series: [{ type: 'bar', data: data.incidentsByType.map((i) => i.count), itemStyle: { color: '#c05a4e' } }],
            }} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="差评归因（硬件/服务/超卖/餐食）">
            <Chart option={{
              tooltip: { trigger: 'item' },
              series: [{ type: 'pie', radius: ['40%', '70%'],
                data: data.reviewByCategory.map((r) => ({ name: REVIEW_CATEGORIES[r.category] || r.category, value: r.count })),
                label: { formatter: '{b}: {c}条' } }],
            }} />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="当日运营成本（保洁/布草/早餐/维修/补偿）"
            extra={<DatePicker value={costDate} allowClear={false} size="small"
              onChange={(d) => { setCostDate(d); loadCosts(d); }} />}>
            {dailyCosts && (
              <>
                <Row gutter={8}>
                  {[
                    { title: '保洁', value: dailyCosts.costs.cleaning, suffix: `（${dailyCosts.details.cleaningTasks}单）` },
                    { title: '布草洗涤', value: dailyCosts.costs.linen, suffix: `（${dailyCosts.details.linenUsed}套）` },
                    { title: '早餐食材', value: dailyCosts.costs.breakfast, suffix: `（${dailyCosts.details.breakfastPortions}份）` },
                    { title: '维修', value: dailyCosts.costs.maintenance, suffix: `（${dailyCosts.details.maintenanceTickets}单）` },
                    { title: '补偿支出', value: dailyCosts.costs.compensation, red: true },
                    { title: '合计', value: dailyCosts.total, red: true },
                  ].map((c) => (
                    <Col span={8} key={c.title} style={{ marginBottom: 8 }}>
                      <Statistic title={c.title} value={c.value} precision={2} prefix="¥"
                        valueStyle={{ fontSize: 18, color: c.red ? '#cf1322' : undefined }}
                        suffix={c.suffix && <span style={{ fontSize: 12, color: '#999' }}>{c.suffix}</span>} />
                    </Col>
                  ))}
                </Row>
                {dailyCosts.details.compensations.length > 0 && (
                  <Table style={{ marginTop: 8 }} size="small" rowKey="id" pagination={false}
                    dataSource={dailyCosts.details.compensations} columns={[
                      { title: '补偿方式', dataIndex: 'type', width: 110, render: (v) => <Tag>{COMP_TYPES[v] || v}</Tag> },
                      { title: '金额', dataIndex: 'amount', width: 80, render: (v) => `¥${v}` },
                      { title: '原因', dataIndex: 'reason' },
                    ]} />
                )}
              </>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
