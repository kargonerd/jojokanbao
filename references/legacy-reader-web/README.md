# web

## Project setup
```
npm install
```

### Compiles and hot-reloads for development
```
npm run serve
```

### Compiles and minifies for production
```
npm run build
```

### Lints and fixes files
```
npm run lint
```

### Customize configuration
See [Configuration Reference](https://cli.vuejs.org/config/).

## GitHub Actions secrets

Set these repository secrets before enabling the workflows:

- `COS_SECRET_ID`
- `COS_SECRET_KEY`
- `COS_BUCKET_NAME`
- `COS_BUCKET_REGION`
- `B2_KEY_ID`
- `B2_APPLICATION_KEY`
- `B2_BUCKET`

`config/env.yml` and `JoJoPipe/config.json` are local-only files. Copy from the corresponding `*.example.*` files when needed. The old tracked secrets should be rotated before publishing any existing Git history to GitHub.
