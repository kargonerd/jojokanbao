<template>
  <doc-viewer :picker-options="pickerOptions" name="hq" type="magazine"
              :fetch-seq-options="getSeqOptions" :gen-seq-text="genSeqText"></doc-viewer>
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
          return time.getTime() > new Date(1976, 12, 0) || time.getTime() < new Date(1958, 12, 0)
        },
      },
    };
  },
  methods: {
    getSeqOptions(date) {
      const config = {
        '1958': [...Array(14).keys()].map(i => i + 1),
        '1959': [...Array(24).keys()].map(i => i + 1),
        '1960': [...Array(24).keys()].map(i => i + 1),
        '1961': [...Array(24).keys()].map(i => i + 1),
        '1962': [...Array(21).keys()].map(i => i + 1),
        '1963': [...Array(24).keys()].map(i => i + 1),
        '1964': [...Array(24).keys()].map(i => i + 1),
        '1965': [...Array(13).keys()].map(i => i + 1),
        '1966': [...Array(15).keys()].map(i => i + 1),
        '1967': [...Array(16).keys()].map(i => i + 1),
        '1968': [...Array(5).keys()].map(i => i + 1),
        '1969': [...Array(12).keys()].map(i => i + 1),
        '1970': [...Array(12).keys()].map(i => i + 1),
        '1971': [...Array(13).keys()].map(i => i + 1),
        '1972': [...Array(12).keys()].map(i => i + 1),
        '1973': [...Array(12).keys()].map(i => i + 1),
        '1974': [...Array(12).keys()].map(i => i + 1),
        '1975': [...Array(12).keys()].map(i => i + 1),
        '1976': [...Array(12).keys()].map(i => i + 1),
      }
      config['1964'].push(91, 92)
      config['1965'].push(91)
      return config[date]
    },
    genSeqText(seq) {
      if (seq > 90) {
        const no = seq % 90
        return '增刊' + no
      }
      return '第' + seq + '期'
    },
  }
}

</script>