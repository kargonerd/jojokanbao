<template>
  <doc-viewer :picker-options="pickerOptions" name="rmrb" :resolution-control="true"></doc-viewer>
</template>

<style>
</style>

<script>
import DocViewer from "@/components/DocViewer.vue";

export default {
  components: {DocViewer},
  data() {
    return {
      pickerOptions: {
        disabledDate(time) {
          // 1. 过滤掉最小日期和最大日期之外的
          const minDate = new Date(1946, 4, 15);
          const maxDate = new Date(2026, 4, 14);
          if (time.getTime() < minDate.getTime() || time.getTime() > maxDate.getTime()) {
            return true;
          }
          
          // 2. 检查整年没有的
          const year = time.getFullYear();
          const missingYears = [1999, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2013];
          if (missingYears.includes(year)) {
            return true;
          }
          
          // 3. 检查整月没有的
          const month = time.getMonth() + 1;
          const yearMonth = year * 100 + month;
          const missingYearMonths = [];
          if (missingYearMonths.includes(yearMonth)) {
            return true;
          }
          
          // 4. 检查单天没有的
          const day = time.getDate();
          const dateStr = year * 10000 + month * 100 + day;
          const missingDates = [19460628, 19460629, 19460630, 19460708, 19460902, 19461215, 19470102, 19470103, 19470104, 19470123, 19470516, 19470702, 19470902, 19480102, 19480103, 19480104, 19480210, 19480516, 19480902, 19481229, 19481230, 19481231, 19490102, 19490130, 19490502, 19490708, 19491007, 19500102, 19500218, 19500219, 19500502, 19510102, 19510206, 19510502, 19520102, 19520127, 19520128, 19520502, 19530102, 19530215, 19530502, 19531002, 19540101, 19540102, 19540112, 19540203, 19540502, 19640728, 19640903, 19720105, 19790204, 20100611, 20100612, 20100613, 20100614, 20100615, 20100616, 20100617, 20100618, 20100619, 20100620, 20100621, 20100622, 20100623, 20100624, 20100625, 20100626, 20100627, 20100628, 20100629, 20100630, 20101224, 20101225, 20111030, 20120524, 20140101, 20140102, 20140103, 20140104, 20140105, 20140106, 20140107, 20140108, 20140109, 20140110];
          return missingDates.includes(dateStr);
        },
        shortcuts: [{
          text: '开国大典',
          value: new Date(1949, 9, 1)
        },
        {
          text: '三大改造',
          value: new Date(1951, 11, 1)
        },
        {
          text: '大跃进',
          value: new Date(1957, 9, 27)
        },
        {
          text: '1966年',
          value: new Date(1966, 4, 16)
        },
        {
          text: '1976年',
          value: new Date(1976, 8, 9)
        }]
      },
    };
  },
}
</script>