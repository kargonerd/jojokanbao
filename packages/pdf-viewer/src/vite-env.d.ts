declare module "*.mjs?url" {
  const url: string;
  export default url;
}

declare module "*.mjs?worker&url" {
  const url: string;
  export default url;
}
