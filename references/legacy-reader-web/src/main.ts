import { createApp } from 'vue'
import '@vuepic/vue-datepicker/dist/main.css'
import '@jojo/editorial-preset'
import App from './App.vue'
import router from './router'

createApp(App).use(router).mount('#app')
