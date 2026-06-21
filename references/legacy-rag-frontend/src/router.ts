import { createRouter, createWebHistory } from 'vue-router'
import ChatView from './views/ChatView.vue'
import BookReader from './views/BookReader.vue'
import AdminView from './views/AdminView.vue'
import AdminAccounts from './views/AdminAccounts.vue'
import AdminLibraries from './views/AdminLibraries.vue'
import AdminLibraryEditor from './views/AdminLibraryEditor.vue'
import AdminSourceEditor from './views/AdminSourceEditor.vue'

const routes = [
  {
    path: '/',
    redirect: '/chat',
  },
  {
    path: '/chat',
    name: 'Chat',
    component: ChatView,
  },
  {
    path: '/source/:notebookId/:sourceId',
    name: 'BookReader',
    component: BookReader,
  },
  {
    path: '/admin',
    name: 'Admin',
    component: AdminView,
    redirect: '/admin/accounts',
    children: [
      {
        path: 'accounts',
        name: 'AdminAccounts',
        component: AdminAccounts,
      },
      {
        path: 'libraries',
        name: 'AdminLibraries',
        component: AdminLibraries,
      },
      {
        path: 'libraries/:notebookId',
        name: 'AdminLibraryEditor',
        component: AdminLibraryEditor,
      },
      {
        path: 'libraries/:notebookId/sources/:sourceId',
        name: 'AdminSourceEditor',
        component: AdminSourceEditor,
      },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

export default router
