<template>
  <doc-viewer :picker-options="pickerOptions" name="rmhb" type="magazine"
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
          if (time.getTime() > new Date(1976, 12, 0) || time.getTime() < new Date(1950, 12, 0)) {
            return true
          }
          if (time.getFullYear() === 1975) {
            return true
          }
          return false
        },
      },
    };
  },
  methods: {
    getSeqOptions(date) {
      const config = {
        '1950': [...Array(6).keys()].map(i => i + 7),
        '1951': [...Array(12).keys()].map(i => i + 1),
        '1952': [...Array(12).keys()].map(i => i + 1),
        '1953': [...Array(12).keys()].map(i => i + 1),
        '1954': [...Array(12).keys()].map(i => i + 1),
        '1955': [...Array(12).keys()].map(i => i + 1),
        '1956': [...Array(12).keys()].map(i => i + 1),
        '1957': [...Array(12).keys()].map(i => i + 1),
        '1958': [...Array(12).keys()].map(i => i + 1),
        '1959': [...Array(13).keys()].map(i => i + 1),
        '1960': [...Array(24).keys()].map(i => i + 1).filter(i => i !== 17),
        '1961': [...Array(12).keys()].map(i => i + 1),
        '1962': [...Array(12).keys()].map(i => i + 1),
        '1963': [...Array(12).keys()].map(i => i + 1),
        '1964': [...Array(12).keys()].map(i => i + 1),
        '1965': [...Array(12).keys()].map(i => i + 1),
        '1966': [...Array(12).keys()].map(i => i + 1),
        '1967': [...Array(12).keys()].map(i => i + 1),
        '1968': [...Array(12).keys()].map(i => i + 1),
        '1969': [...Array(12).keys()].map(i => i + 1),
        '1970': [...Array(12).keys()].map(i => i + 1),
        '1971': [...Array(12).keys()].map(i => i + 1),
        '1972': [...Array(12).keys()].map(i => i + 1).filter(i => i !== 11),
        '1973': [...Array(12).keys()].map(i => i + 1),
        '1974': [...Array(12).keys()].map(i => i + 1),
        '1976': [...Array(11).keys()].map(i => i + 1).filter(i => i !== 7),
      }
      config['1960'].push(91)
      config['1967'].push(91, 92)
      config['1968'].push(91, 92, 93, 94, 95, 96)
      config['1970'].push(91, 92, 93, 94)
      config['1972'].push(91, 92, 93, 94)
      config['1976'].push(91)
      return config[date]
    },
    genSeqText(seq) {
      if (seq > 90) {
        const no = seq % 90
        return '增刊' + no
      }
      return '第' + seq + '期'
    },
  },
}

</script>