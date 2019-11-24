#!/bin/bash -e
#
# This script builds the example project using Emscripten via docker.
# Nothing else than Docker is required for this to work.
# You can get Docker from Homebrew, Aptitude and other package managers,
# as well as from the Docker website: https://docker.com/
#
# If you have Emscripten and Nodejs installed locally, you can build
# directly, without Docker, with the -local flag: `build.sh -local`
#
cd "$(dirname "$0")"

if [ "$1" == "-local" ]; then
  shift
  mkdir -p out

  # flags
  emcc_flags=()
  wasmc_flags=()
  if [ "$1" == "-O" ]; then
    shift
    emcc_flags+=( -Oz )
  else
    emcc_flags+=( -g )
    wasmc_flags+=( -g )
  fi

  if [ "$1" == "-pretty" ]; then
    wasmc_flags+=( $1 )
    shift
  fi

  # compile C to WASM
  echo "emcc" *.c "-> out/foo.js"
  emcc \
    -s WASM=1 \
    -s NO_EXIT_RUNTIME=1 \
    -s NO_FILESYSTEM=1 \
    -s ABORTING_MALLOC=0 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s RESERVED_FUNCTION_POINTERS=1 \
    -s DISABLE_EXCEPTION_CATCHING=1 \
    --js-library lib.js \
    --js-opts 0 \
    --closure 0 \
    --minify 0 \
    "${emcc_flags[@]}" \
    -o out/foo.js \
    *.c

  cp -a out/foo.js out/emcc.foo.js
  ls -lF out/foo.wasm

  # Bundle, combining your javascript and wasm code
  echo "wasmc -syncinit out/foo.js foo.js"
  ../wasmc \
    "${wasmc_flags[@]}" \
    -target=node \
    -DHELLO_WORLD="[1, 2+5, '3']" \
    -syncinit \
    out/foo.js \
    foo.js

  # Run via nodejs
  echo 'Testing in nodejs: require("./out/foo.js").hello()'
  node -e 'require("./out/foo.js").hello()'

  # if we did not provide -syncinit then we'd have to wait for the
  # "ready" promise before calling functions:
  # node -e 'require("./out/foo.js").ready.then(m => m.hello())'

else
  # Build via Docker using an emsdk image
  if ! (which docker > /dev/null); then
    echo "docker not found in PATH. See https://docker.com/" >&2
    exit 1
  fi
  docker run --rm -t -v "$PWD/..:/src" rsms/emsdk:latest \
    /bin/bash example/build.sh -local "$@"
  wasm2wat out/foo.wasm -o out/foo.wast
fi
