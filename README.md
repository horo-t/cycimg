# cycimg

## How to minify
```shell-session
$ java -jar ../closure-compiler/closure-compiler-v20170626.jar \
  --compilation_level ADVANCED \
  --js cycimg.js \
  --js_output_file cycimg_min.js \
  --rewrite_polyfills false
  ```
