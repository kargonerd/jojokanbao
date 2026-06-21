<template>
  <doc-viewer :picker-options="pickerOptions" name="sjzs" type="magazine"
              :fetch-seq-options="getSeqOptions" :gen-seq-text="genSeqText" :enable-text-layer="true"></doc-viewer>
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
          let availableYears = [];
          // 遍历年份文件夹，收集所有存在的年份
          availableYears = [1934, 1935, 1936, 1937, 1938, 1939, 1940, 1941, 1945, 1946, 1947, 1948, 1949, 1950, 1951, 1952, 1953, 1954, 1955, 1956, 1957, 1958, 1959, 1960, 1961, 1962, 1963, 1964, 1965, 1966, 1978, 1979, 1980, 1981, 1982, 1983, 1984, 1985, 1986, 1987, 1988, 1989, 1990, 1991, 1992, 1993, 1994, 1995, 1996, 1997, 1998, 1999, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
          const minYear = Math.min(...availableYears);
          const maxYear = Math.max(...availableYears);
          const minDate = new Date(minYear, 0, 0);
          const maxDate = new Date(maxYear, 11, 31);
          if (time.getTime() < minDate.getTime()) {
            return true;
          }
          if (time.getTime() > maxDate.getTime()) {
            return true;
          }
          return!availableYears.includes(time.getFullYear());
        },
      },
    };
  },
  methods: {
    getSeqOptions(date) {
      const config = {
        "1934": [...Array(6).keys()].map(i => i + 1),
        "1935": [...Array(6).keys()].map(i => i + 1),
        "1936": [...Array(6).keys()].map(i => i + 1),
        "1937": [...Array(6).keys()].map(i => i + 1),
        "1938": [...Array(6).keys()].map(i => i + 1),
        "1939": [...Array(6).keys()].map(i => i + 1),
        "1940": [...Array(11).keys()].map(i => i + 1).filter(i => i!== 5 && i!== 6),
        "1941": [...Array(7).keys()].map(i => i + 9),
        "1945": [12],
        "1946": [...Array(30).keys()].map(i => i + 1).filter(i => i!== 4),
        "1947": [...Array(6).keys()].map(i => i + 1),
        "1948": [...Array(6).keys()].map(i => i + 1),
        "1949": [...Array(6).keys()].map(i => i + 1),
        "1950": [...Array(24).keys()].map(i => i + 1).concat([91]),
        "1951": [...Array(50).keys()].map(i => i + 1).filter(i => i!== 34),
        "1952": [...Array(50).keys()].map(i => i + 1).filter(i => i!== 35),
        "1953": [...Array(24).keys()].map(i => i + 1),
        "1954": [...Array(24).keys()].map(i => i + 1),
        "1955": [...Array(24).keys()].map(i => i + 1),
        "1956": [...Array(24).keys()].map(i => i + 1),
        "1957": [...Array(24).keys()].map(i => i + 1),
        "1958": [...Array(24).keys()].map(i => i + 1).concat([91]),
        "1959": [...Array(24).keys()].map(i => i + 1),
        "1960": [...Array(24).keys()].map(i => i + 1),
        "1961": [...Array(24).keys()].map(i => i + 1),
        "1962": [...Array(24).keys()].map(i => i + 1).filter(i => i!== 23),
        "1963": [...Array(24).keys()].map(i => i + 1),
        "1964": [...Array(24).keys()].map(i => i + 1),
        "1965": [...Array(24).keys()].map(i => i + 1),
        "1966": [...Array(12).keys()].map(i => i + 1).filter(i => i!== 10 && i!== 11),
        "1978": [1],
        "1979": [...Array(24).keys()].map(i => i + 1),
        "1980": [...Array(24).keys()].map(i => i + 1),
        "1981": [...Array(24).keys()].map(i => i + 1),
        "1982": [...Array(24).keys()].map(i => i + 1),
        "1983": [...Array(24).keys()].map(i => i + 1),
        "1984": [...Array(24).keys()].map(i => i + 1),
        "1985": [...Array(24).keys()].map(i => i + 1),
        "1986": [...Array(24).keys()].map(i => i + 1),
        "1987": [...Array(24).keys()].map(i => i + 1),
        "1988": [...Array(24).keys()].map(i => i + 1),
        "1989": [...Array(24).keys()].map(i => i + 1),
        "1990": [...Array(24).keys()].map(i => i + 1),
        "1991": [...Array(24).keys()].map(i => i + 1),
        "1992": [...Array(24).keys()].map(i => i + 1),
        "1993": [...Array(24).keys()].map(i => i + 1),
        "1994": [...Array(24).keys()].map(i => i + 1),
        "1995": [...Array(24).keys()].map(i => i + 1),
        "1996": [...Array(24).keys()].map(i => i + 1),
        "1997": [...Array(24).keys()].map(i => i + 1),
        "1998": [...Array(24).keys()].map(i => i + 1),
        "1999": [...Array(24).keys()].map(i => i + 1),
        "2000": [...Array(24).keys()].map(i => i + 1),
        "2001": [...Array(24).keys()].map(i => i + 1),
        "2002": [...Array(24).keys()].map(i => i + 1),
        "2003": [...Array(24).keys()].map(i => i + 1),
        "2004": [...Array(24).keys()].map(i => i + 1),
        "2005": [...Array(24).keys()].map(i => i + 1),
        "2006": [...Array(24).keys()].map(i => i + 1),
        "2007": [...Array(24).keys()].map(i => i + 1),
        "2008": [...Array(24).keys()].map(i => i + 1),
        "2009": [...Array(24).keys()].map(i => i + 1).filter(i => i!== 6),
        "2010": [...Array(24).keys()].map(i => i + 1),
        "2011": [...Array(24).keys()].map(i => i + 1),
        "2012": [...Array(24).keys()].map(i => i + 1),
        "2013": [...Array(24).keys()].map(i => i + 1).filter(i => i!== 11),
        "2014": [...Array(24).keys()].map(i => i + 1),
        "2015": [...Array(24).keys()].map(i => i + 1),
        "2016": [...Array(24).keys()].map(i => i + 1).filter(i => i!== 7),
        "2017": [...Array(24).keys()].map(i => i + 1),
        "2018": [...Array(24).keys()].map(i => i + 1),
        "2019": [...Array(24).keys()].map(i => i + 1),
        "2020": [...Array(24).keys()].map(i => i + 1),
        "2021": [...Array(24).keys()].map(i => i + 1),
        "2022": [...Array(24).keys()].map(i => i + 1),
        "2023": [...Array(24).keys()].map(i => i + 1),
        "2024": [...Array(24).keys()].map(i => i + 1),
        "2025": [...Array(17).keys()].map(i => i + 1).filter(i => i!== 13),
      };
      return config[date]
    },
    genSeqText(seq) {
      if (seq > 90) {
        const no = seq % 90
        return '增刊' + no
      }
      return '第' + seq + '期'
    },
  }}
</script>