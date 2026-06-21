import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'home', component: HomeView, meta: { title: '首页' } },
    { path: '/rmrb/:id(\\d{8})', name: 'rmrb', component: () => import('../views/RMRBView.vue'), meta: { title: '人民日报' } },
    { path: '/rmrb', redirect: '/rmrb/19701009' },
    { path: '/hq/:id(\\d{6})', name: 'hq', component: () => import('../views/HQView.vue'), meta: { title: '红旗' } },
    { path: '/hq', redirect: '/hq/196419' },
    { path: '/sjzs/:id(\\d{6})', name: 'sjzs', component: () => import('../views/SJZSView.vue'), meta: { title: '世界知识' } },
    { path: '/ckxx/:id(\\d{8})', name: 'ckxx', component: () => import('../views/CKXXView.vue'), meta: { title: '参考消息' } },
    { path: '/ckxx', redirect: '/ckxx/19760910' },
    { path: '/rmhb/:id(\\d{6})', name: 'rmhb', component: () => import('../views/RMHBView.vue'), meta: { title: '人民画报' } },
    { path: '/rmhb', redirect: '/rmhb/197292' },
    { path: '/support', name: 'support', component: () => import('../views/SupportView.vue'), meta: { title: '支持我们' } },
    { path: '/search', name: 'search', component: () => import('../views/SearchView.vue'), meta: { title: '搜索' } },
    { path: '/:w+', name: '404', component: () => import('../views/404View.vue'), meta: { title: '404' } },
  ],
})

router.beforeEach((to) => {
  let title = (to.meta.title as string) || 'JOJO看报'
  if (to.params.id) title += ' ' + to.params.id
  document.title = title + ' - JOJO看报'
})

export default router
