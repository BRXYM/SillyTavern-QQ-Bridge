import { createRouter, createWebHashHistory } from 'vue-router';

export interface NavMeta {
    title: string;
    desc: string;
    icon: string;
    /** 侧栏分组 */
    group: string;
}

const routes = [
    {
        path: '/',
        name: 'dashboard',
        component: () => import('@/views/DashboardView.vue'),
        meta: { title: '总览', desc: '服务与运行状态', icon: 'LayoutDashboard', group: '监控' } satisfies NavMeta,
    },
    {
        path: '/logs',
        name: 'logs',
        component: () => import('@/views/LogsView.vue'),
        meta: { title: '运行日志', desc: '实时事件流', icon: 'Terminal', group: '监控' } satisfies NavMeta,
    },
    {
        path: '/flows',
        name: 'flows',
        component: () => import('@/views/FlowsView.vue'),
        meta: { title: '消息流程', desc: '自由组合算子，编排下游配置', icon: 'Boxes', group: '流程与会话' } satisfies NavMeta,
    },
    {
        path: '/snowluma',
        name: 'snowluma',
        component: () => import('@/views/ServicesView.vue'),
        meta: { title: '上游连接', desc: '多账号连接与 OneBot 接入', icon: 'Server', group: '连接资源' } satisfies NavMeta,
    },
    {
        path: '/downstreams',
        name: 'downstreams',
        component: () => import('@/views/DownstreamsView.vue'),
        meta: { title: '下游连接', desc: '服务实例、连接参数与协议映射', icon: 'Boxes', group: '连接资源' } satisfies NavMeta,
    },
    { path: '/profiles', redirect: '/flows' },
    {
        path: '/sessions',
        name: 'sessions',
        component: () => import('@/views/SessionsView.vue'),
        meta: { title: '会话管理', desc: '选择下游连接与流程配置', icon: 'Users', group: '流程与会话' } satisfies NavMeta,
    },
    {
        path: '/segmentation',
        name: 'segmentation',
        component: () => import('@/views/SegmentationView.vue'),
        meta: { title: '回复分段', desc: '分隔符与节奏', icon: 'Scissors', group: '消息' } satisfies NavMeta,
    },
    {
        path: '/media',
        name: 'media',
        component: () => import('@/views/MediaView.vue'),
        meta: { title: '图片表情', desc: '多媒体回复', icon: 'Image', group: '消息' } satisfies NavMeta,
    },
    {
        path: '/ollama',
        name: 'ollama',
        component: () => import('@/views/OllamaView.vue'),
        meta: { title: 'AI 模型', desc: 'Ollama 本地模型', icon: 'BrainCircuit', group: '消息' } satisfies NavMeta,
    },
    {
        path: '/settings',
        name: 'settings',
        component: () => import('@/views/SettingsView.vue'),
        meta: { title: '系统设置', desc: '连接与触发', icon: 'SlidersHorizontal', group: '系统' } satisfies NavMeta,
    },
];

export default createRouter({
    history: createWebHashHistory(),
    routes,
});
