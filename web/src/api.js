import axios from 'axios';
import { message } from 'antd';

const api = axios.create({ baseURL: '/api', timeout: 15000 });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res.data,
  (err) => {
    const msg = err.response?.data?.message || err.message || '请求失败';
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (!location.pathname.startsWith('/login')) location.href = '/login';
    }
    message.error(Array.isArray(msg) ? msg[0] : msg);
    return Promise.reject(err);
  },
);

export default api;

export const INCIDENT_TYPES = {
  late_checkout: '延迟退房', ac_failure: '空调故障', linen_delay: '布草延迟',
  extra_guests: '临时加人', pet_damage: '宠物损坏', breakfast_shortage: '早餐不足',
  oversell: '渠道超卖', bad_review: '差评', other: '其他',
};
export const REVIEW_CATEGORIES = { hardware: '硬件', service: '服务', oversell: '超卖', food: '餐食' };
export const BOOKING_STATUS = {
  booked: { text: '待入住', color: 'blue' },
  checked_in: { text: '在住', color: 'green' },
  checked_out: { text: '已退房', color: 'default' },
  cancelled: { text: '已取消', color: 'red' },
};
export const ROOM_STATUS = {
  clean: { text: '已清洁', color: 'green' },
  dirty: { text: '待打扫', color: 'orange' },
  cleaning: { text: '打扫中', color: 'blue' },
  inspected: { text: '已验收', color: 'cyan' },
  maintenance: { text: '维修中', color: 'red' },
  awaiting_linen: { text: '待布草', color: 'volcano' },
};
export const LINEN_COMP_TYPES = {
  afternoon_tea: { text: '下午茶', color: 'gold' },
  room_change: { text: '换房', color: 'purple' },
  late_checkin: { text: '延迟入住补偿', color: 'orange' },
};
export const BLOCK_STATUS = {
  active: { text: '待布草', color: 'red' },
  reassigned: { text: '已换房', color: 'purple' },
  resolved: { text: '布草已到', color: 'green' },
};
export const TASK_STATUS = {
  pending: { text: '待派单', color: 'orange' },
  assigned: { text: '已派单', color: 'blue' },
  in_progress: { text: '打扫中', color: 'processing' },
  done: { text: '已完成', color: 'green' },
  inspected: { text: '已验收', color: 'cyan' },
};
export const DIRTINESS = { light: '轻度', normal: '正常', heavy: '重度' };
export const INCIDENT_STATUS = { open: { text: '待处理', color: 'red' }, processing: { text: '处理中', color: 'orange' }, resolved: { text: '已解决', color: 'green' } };
