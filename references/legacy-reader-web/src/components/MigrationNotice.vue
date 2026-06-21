<template>
  <main class="migration-page">
    <section class="migration-card" aria-labelledby="migration-title">
      <div class="migration-card__eyebrow">JOJO看报</div>
      <h1 id="migration-title">网站暂时无法使用</h1>
      <p>
        暂时由于一些原因无法访问报刊内容，我们正在进行数据迁移，请大家耐心等待。
      </p>
    </section>
  </main>
</template>

<script>
export default {
  name: 'MigrationNotice'
}
</script>

<style scoped>
.migration-page {
  min-height: calc(100vh - 92px);
  padding: 72px 18px 48px;
  box-sizing: border-box;
}

.migration-card {
  position: relative;
  max-width: 760px;
  margin: 0 auto;
  padding: 54px 56px 44px;
  color: #2e261b;
  background: rgba(255, 252, 244, 0.88);
  border: 1px solid rgba(114, 84, 44, 0.2);
  border-radius: 6px;
  box-shadow: 0 28px 80px rgba(71, 47, 17, 0.16);
  box-sizing: border-box;
  overflow: hidden;
}

.migration-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  width: 8px;
  height: 100%;
  background: #8b1e16;
}

.migration-card__eyebrow {
  color: #8b1e16;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.28em;
}

.migration-card h1 {
  margin: 16px 0 18px;
  font-family: Georgia, 'Times New Roman', 'SimSun', serif;
  font-size: 48px;
  font-weight: 700;
  line-height: 1.12;
  letter-spacing: 0.04em;
}

.migration-card p {
  max-width: 560px;
  margin: 0;
  color: #5c4a32;
  font-size: 18px;
  line-height: 2;
}

.migration-card__divider {
  width: 100%;
  height: 1px;
  margin: 34px 0 20px;
  background: linear-gradient(90deg, rgba(139, 30, 22, 0.45), transparent);
}

.migration-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 18px;
  color: #816a49;
  font-size: 13px;
  letter-spacing: 0.08em;
}

.migration-card__meta span::before {
  content: '— ';
  color: #8b1e16;
}

@media (max-width: 640px) {
  .migration-page {
    padding: 40px 14px 32px;
  }

  .migration-card {
    padding: 38px 28px 32px;
  }

  .migration-card h1 {
    font-size: 36px;
  }

  .migration-card p {
    font-size: 16px;
  }
}
</style>
