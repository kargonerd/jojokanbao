const { resolveAccountConfig } = require("./account-config.cjs");

const STANDARD_IDENTIFIER = "com.luoxixi.jojokanbao";
const EINK_IDENTIFIER = `${STANDARD_IDENTIFIER}.eink`;

module.exports = ({ config }) => {
  const eInk = process.env.APP_VARIANT === "eink"
    || process.env.EXPO_PUBLIC_APP_VARIANT === "eink";

  return {
    ...config,
    name: "JOJO看报",
    icon: eInk ? "./assets/icon-eink.png" : config.icon,
    scheme: eInk ? "jojokanbaoeink" : "jojokanbao",
    splash: eInk
      ? {
          ...config.splash,
          image: "./assets/splash-icon-eink.png",
          backgroundColor: "#ffffff",
        }
      : config.splash,
    ios: {
      ...config.ios,
      bundleIdentifier: STANDARD_IDENTIFIER,
    },
    android: {
      ...config.android,
      package: eInk ? EINK_IDENTIFIER : STANDARD_IDENTIFIER,
      adaptiveIcon: eInk
        ? {
            backgroundColor: "#000000",
            foregroundImage: config.android?.adaptiveIcon?.foregroundImage,
            monochromeImage: config.android?.adaptiveIcon?.monochromeImage,
          }
        : config.android?.adaptiveIcon,
    },
    extra: {
      ...config.extra,
      account: resolveAccountConfig(__dirname),
      appVariant: eInk ? "eink" : "standard",
    },
  };
};
