<script setup lang="ts">
import weixinImg from '../assets/weixin.png'
import zfbImg from '../assets/zfb.png'

const downloads = [
  { name: '人民日报', links: [
    { label: 'OneDrive下载', url: 'https://1drv.ms/u/s!Aj2JC1hBTlqzh8AE964HD8Mc6HAzjQ?e=QO8bmf' },
    { label: 'OneDrive备用下载', url: 'https://filesshare-my.sharepoint.com/:f:/g/personal/sun_filesshare_onmicrosoft_com/EsQTAcYn4WFHrqXY0YalQEIB1hin6BxrfKof5iq4JeC93w?e=h3vmfC' },
    { label: '夸克网盘下载', url: 'https://pan.quark.cn/s/e1bccf36d345' },
  ]},
  { name: '参考消息', links: [
    { label: 'OneDrive下载', url: 'https://1drv.ms/u/s!Aj2JC1hBTlqzh8AD4aXgZxiLlXtAFQ?e=BQxZoZ' },
    { label: '夸克网盘下载', url: 'https://pan.quark.cn/s/60ad563e7939' },
  ]},
  { name: '红旗杂志', links: [
    { label: 'OneDrive下载', url: 'https://1drv.ms/u/s!Aj2JC1hBTlqzh8AGcjcraz5iymoHbQ?e=nnw50i' },
    { label: '夸克网盘下载', url: 'https://pan.quark.cn/s/98470c9d1908' },
  ]},
  { name: '人民画报', links: [
    { label: 'OneDrive下载', url: 'https://1drv.ms/f/s!Aj2JC1hBTlqzkud_9htgwD5G2zOCjg?e=iJ42bO' },
    { label: '夸克网盘下载', url: 'https://pan.quark.cn/s/eeb9d114304f' },
  ]},
  { name: '世界知识', links: [
    { label: 'OneDrive下载', url: 'https://1drv.ms/f/s!Aj2JC1hBTlqzld1xkycRNnHRKXQqXw?e=eWSdrC' },
    { label: '夸克网盘下载', url: 'https://pan.quark.cn/s/68c2c60ab36b' },
  ]},
]
</script>

<template>
  <div class="h-full overflow-y-auto bg-paper">
    <div class="max-w-[960px] mx-auto px-5 py-7 md:px-10">
      <div class="p-8 md:p-10 border-4 border-red shadow-[inset_0_0_0_8px_var(--color-paper),inset_0_0_0_10px_var(--color-red)]">

        <!-- 反馈 -->
        <h1 class="text-2xl font-bold tracking-wider text-ink border-t border-rule-dark border-b border-b-rule pt-2.5 pb-2.5 mb-4">反馈</h1>
        <p class="text-ink/80 leading-8">
          网站为业余时间开发制作，因此较为粗糙，如果网站有任何问题，或者希望对网站提出建议，可以进入QQ群:
          <strong class="text-red">974380749</strong> 进行反馈，也可以在B站
          <a href="https://space.bilibili.com/571556400" target="_blank" class="font-bold">JOJO看报账号</a>
          下留言或私信反馈
        </p>

        <!-- 纪念缅怀 -->
        <h1 class="text-2xl font-bold tracking-wider text-ink border-t border-rule-dark border-b border-b-rule pt-2.5 pb-2.5 mt-7 mb-4">纪念缅怀</h1>
        <ul class="list-none p-0 m-0">
          <li class="py-2.5 border-b border-rule">
            <a href="https://redstar.jojokanbao.cn" target="_blank" class="font-bold flex items-center gap-1.5">
              <svg class="w-4 h-4 text-red" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1l2.39 4.84 5.34.78-3.87 3.77.91 5.32L10 13.27l-4.77 2.51.91-5.32L2.27 6.69l5.34-.78L10 1z"/></svg>
              纪念毛主席诞辰132周年（2025）
            </a>
          </li>
        </ul>

        <!-- 数据下载 -->
        <h1 class="text-2xl font-bold tracking-wider text-ink border-t border-rule-dark border-b border-b-rule pt-2.5 pb-2.5 mt-7 mb-4">数据下载</h1>
        <div class="space-y-3">
          <p v-for="d in downloads" :key="d.name" class="leading-8 text-ink/80">
            <strong class="text-red mr-1">{{ d.name }}：</strong>
            <template v-for="(link, i) in d.links" :key="link.url">
              <a :href="link.url" target="_blank" class="font-bold">{{ link.label }}</a>
              <span v-if="i < d.links.length - 1" class="mx-2 text-rule">|</span>
            </template>
          </p>
        </div>

        <!-- 捐助 -->
        <h1 class="text-2xl font-bold tracking-wider text-ink border-t border-rule-dark border-b border-b-rule pt-2.5 pb-2.5 mt-7 mb-4">捐助</h1>
        <p class="text-ink/80 leading-8">
          如果网站对您有帮助，您可以通过捐助支持我们，所有捐助都将用于维护本网站，所有捐助记录将在
          <a href="https://docs.qq.com/sheet/DZlhxZUdmalFBUUFQ?tab=BB08J2" target="_blank" class="font-bold">JOJO看报捐助列表</a>
          中公示
        </p>
        <div class="flex flex-wrap gap-4 mt-4">
          <img :src="weixinImg" alt="微信" class="max-w-[240px] border border-rule-dark" />
          <img :src="zfbImg" alt="支付宝" class="max-w-[240px] border border-rule-dark" />
        </div>
      </div>
    </div>
  </div>
</template>
