#!/bin/bash -e
cd "$(dirname "$0")/.."

./deps/build.sh

PROG=$0
DEBUG=false
ROLLUP_ARGS=

function usage {
  echo "usage: $PROG [options]"
  echo "options:"
  echo "-g, -debug  Create debug build instead of release build"
  echo "-w, -watch  Watch source files for changes & rebuild"
  echo "-h, -help   Show help on stdout and exit"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
  help|-h|-help|--help)
    usage
    exit 0
    shift
    ;;
  -g|-debug|--debug)
    DEBUG=true
    shift
    ;;
  -w|-watch|--watch)
    ROLLUP_ARGS=--watch
    shift
    ;;
  -*)
    echo "$PROG: Unknown command or option $1" >&2
    usage >&2
    exit 1
    shift
    ;;
  esac
done


function closure-compiler {
  if [[ -z $CCOMPILER ]]; then
    CCOMPILER=$(node -e "process.stdout.write(require('google-closure-compiler/lib/utils').getNativeImagePath())")
  fi
  "$CCOMPILER" "$@"
}


WASMC_VERSION=$(node -p 'require("./package.json").version')
if [[ -d .git ]]; then
  WASMC_VERSION="$WASMC_VERSION ($(git rev-parse --short HEAD))"
fi


# prerequisites
if [[ misc/ninjabot.js -nt src/ninjabot-program.js ]]; then
  echo "closure-compiler misc/ninjabot.js -> src/ninjabot-program.js"
  closure-compiler \
    -O=SIMPLE \
    --js=misc/ninjabot.js \
    --js_output_file=misc/.ninjabot.js \
    --language_in=ECMASCRIPT_2020 \
    --language_out=ECMASCRIPT_NEXT \
    --env=CUSTOM \
    --module_resolution=NODE \
    --package_json_entry_names=esnext:main,browser,main \
    --assume_function_wrapper \
    --charset=UTF-8 \
    --output_wrapper="$(printf "#!/usr/bin/env node --input-type=module\n%%output%%")"

node <<_JS
const fs = require('fs');
const { inspect } = require('util');

let s = fs.readFileSync('misc/.ninjabot.js', 'utf8');

s = '// generated from misc/ninjabot.js by misc/build.sh -- do not edit manually\n' +
    'export default ' + inspect(s) + '\n';

fs.writeFileSync('src/ninjabot-program.js', s, 'utf8');
_JS

  rm misc/.ninjabot.js
fi


if $DEBUG; then
  if [ ! -f wasmc.g.cjs ]; then
    touch wasmc.g.cjs
    chmod +x wasmc.g.cjs
  fi
  ./node_modules/.bin/rollup $ROLLUP_ARGS \
    -o wasmc.g.cjs \
    --format cjs \
    --sourcemap inline \
    --intro "const WASMC_VERSION='$WASMC_VERSION',DEBUG=true;" \
    --banner '#!/usr/bin/env node' \
    src/main.js

else
  ./node_modules/.bin/rollup $ROLLUP_ARGS \
    -o .wasmc.js \
    --format cjs \
    --sourcemap inline \
    --intro "const WASMC_VERSION='$WASMC_VERSION',DEBUG=false;" \
    --banner '#!/usr/bin/env node --input-type=module' \
    src/main.js

# strip comments
node <<_JS
const fs = require('fs');
let s = fs.readFileSync('.wasmc.js', 'utf8');

// replace with whitespace and linebreaks to not mess up sourcemap
s = s.replace(/(?:^|\n\s*)\/\*(?:(?!\*\/).)*\*\//gms, s => {
  let s2 = '';
  for (let i = 0; i < s.length; i++) {
    s2 += s.charCodeAt(i) == 0xA ? '\n' : ' ';
  }
  return s2;
});
fs.writeFileSync('.wasmc.js', s, 'utf8');
_JS

  echo "running closure-compiler"
  closure-compiler \
    -O=SIMPLE \
    --js=.wasmc.js \
    --js_output_file=wasmc.cjs \
    --language_in=ECMASCRIPT_2020 \
    --language_out=ECMASCRIPT_NEXT \
    --env=CUSTOM \
    \
    --module_resolution=NODE \
    --package_json_entry_names=esnext:main,browser,main \
    --assume_function_wrapper \
    --create_source_map=wasmc.map \
    --source_map_input=".wasmc.js|.wasmc.js.map" \
    \
    --charset=UTF-8 \
    --output_wrapper="$(printf "#!/usr/bin/env node\n/* eslint-disable */\n//prettier-ignore\n%%output%%\n//#sourceMappingURL=wasmc.map")"

  rm .wasmc.js
  chmod +x wasmc.cjs
fi
