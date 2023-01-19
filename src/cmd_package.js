/**
 * post-emscripten WASM packaging
 *
 * TODO: split out packaging code from CLI code (see build: builder.js + cmd_build.js)
 */
import rollup from '../deps/build/rollup.js';
import uglify from '../deps/build/uglify-es.js';
import { stripext, NODE_VERSION_GTE_11_7 } from './util';
import { parseopts } from './parseopts';
import defaultJsentry from './default-jsentry';
import fs from 'node:fs';
import Path from 'node:path';
import { brotliCompressSync } from 'node:zlib';

const options = {
  h: false,
  help: false,
  g: false,
  debug: false,
  v: false,
  verbose: false,
  pretty: false, // when true, pretty-print output. on by default when debug
  esmod: false,
  embed: false,
  syncinit: false,
  wasm: null,
  'inline-sourcemap': false,
  nosourcemap: false,
  noconsole: false, // silence all print calls (normally routed to console)
  nostdout: false, // silence output to stdout (normally routed to console.log)
  nostderr: false, // silence output to stderr (normally routed to console.error)
  target: null,
  ecma: 0,

  globalDefs: {}, // -Dname=val
};

function usage() {
  console.error(
    `
  usage: wasmc -Tpackage [options] <emccfile> <jsentryfile>

  options:
    -h, -help          Show help message and exit
    -v, -verbose       Print extra information to stdout
    -g, -debug         Disable optimizations and include data for debugging.

    -o=<file>          Output JS file. Defaults to <emccfile>.
    -esmod             Generate ES module instead of UMD module.
    -ecma=<version>    ES target version. Defaults to 8 (ES2017). Range: 5–8.
    -embed             Embed WASM code in JS file.
    -syncinit          Load & initialize WASM module on main thread.
                       Useful for NodeJS. May cause issues in web browsers.
    -wasm=<file>       Custom name of wasm file. Defaults to <emccfile-.js>.wasm
    -pretty            Generate pretty code. Implied with -g, -debug.
    -inline-sourcemap  Store source map inline instead of <outfile>.map
    -nosourcemap       Do not generate a source map
    -noconsole         Silence all print calls (normally routed to console)
    -nostderr          Silence output to stdout (normally routed to console.log)
    -nostdout          Silence output to stderr (normally routed to console.error)
    -D<name>[=<val>]   Define constant global <name>. <val> defaults to \`true\`.
    -target=<target>   Build only for <target>. Sets a set of -D definitions to
                       include only code required for the target. Generates
                       smaller output but is less portable.

  Available <target> values:
    node    NodeJS-like environments
    web     Web browser
    worker  Web worker

  Predefined constants: (can be overridden)
    -DDEBUG    \`true\` when -g or -debug is set, otherwise \`false\`

  `
      .trim()
      .replace(/^\s{2}/gm, '') + '\n'
  );
  process.exit(1);
}

function die(msg) {
  console.error('wasmc -Tpackage: ' + msg);
  console.error(`See wasmc -Tpackage -h for help`);
  process.exit(1);
}

function targetDefs(target) {
  switch (target) {
    case 'node-legacy':
    case 'node':
      return {
        WASMC_IS_NODEJS_LIKE: true,
        ENVIRONMENT_IS_WEB: false,
        ENVIRONMENT_IS_WORKER: false,
        ENVIRONMENT_IS_NODE: true,
        ENVIRONMENT_HAS_NODE: true,
        ENVIRONMENT_IS_SHELL: false,
      };
    case 'web':
      return {
        WASMC_IS_NODEJS_LIKE: false,
        ENVIRONMENT_IS_WEB: true,
        ENVIRONMENT_IS_WORKER: false,
        ENVIRONMENT_IS_NODE: false,
        ENVIRONMENT_HAS_NODE: false,
        ENVIRONMENT_IS_SHELL: false,
      };
    case 'worker':
      return {
        WASMC_IS_NODEJS_LIKE: false,
        ENVIRONMENT_IS_WEB: false,
        ENVIRONMENT_IS_WORKER: true,
        ENVIRONMENT_IS_NODE: false,
        ENVIRONMENT_HAS_NODE: false,
        ENVIRONMENT_IS_SHELL: false,
      };
    default:
      die(`invalid -target ${JSON.stringify(target)}`);

    // node    NodeJS-like environments
    // web     Web browser
    // worker  Web worker
  }
}

export async function main(c, args) {
  let opts = { ...options };
  args = parseopts(args, opts, usage);

  opts.debug = opts.debug || opts.g;
  opts.verbose = opts.verbose || opts.v;
  opts.ecma = opts.ecma ? parseInt(opts.ecma) : 8;
  opts.inlineSourcemap = opts['inline-sourcemap'];
  opts.wasmfile = opts.wasm;

  if (opts.h || opts.help) {
    usage();
  }

  if (isNaN(opts.ecma) || opts.ecma < 5 || opts.ecma > 8) {
    die('-ecma requires a number in the range [5-8]');
  }

  if (opts.embed && opts.wasm) {
    die('Both -embed and -wasm was provided. Pick one.');
  }

  opts.emccfile = args[0];
  opts.jsentryfile = args[1];
  opts.outfile = opts.o || opts.emccfile; // overwrite unless -o is given

  let { code, sourcemap } = await packageModule(c, opts);
  if (sourcemap) {
    fs.writeFileSync(opts.outfile + '.map', sourcemap, 'utf8');
  }
  fs.writeFileSync(opts.outfile, code, 'utf8');
}

// interface WrapOptions {
//   emccfile    :string  // path to JS file generated by emcc
//   jsentryfile :string  // path to wrapper input JS entry file
//   outfile     :string  // path of output file
//   projectdir  :string  // directory path of root directory
//
//   // Optional:
//   modname?         : string  // name of module. Defaults to basename(outfile) w/o ext
//   wasmfile?        : string  // custom .wasm filename
//   globalDefs?      : {}
//   target?          : "node" | "node-legacy" | "web" | "worker" | null
//   debug?           : bool  // produce debug build instead of optimized build
//   pretty?          : bool  // when true, pretty-print output. on by default when debug
//   ecma?            : number  // [5-8]  ES standard. Defaults to latest. 0 = latest = 8.
//   esmod?           : bool
//   embed?           : bool  // embed wasm file inside js file
//   syncinit?        : bool
//   inlineSourcemap? : bool
//   sourcemapFile?   : string
//   nosourcemap?     : bool  // do not generate sourcemap
//   noconsole?       : bool  // silence all print calls (normally routed to console)
//   nostdout?        : bool  // silence output to stdout (normally routed to console.log)
//   nostderr?        : bool  // silence output to stderr (normally routed to console.error)
// }
//
export function packageModule(c, options) {
  // :Promise<{code:string,sourcemap:string}>
  let opts = {
    // defaults
    globalDefs: {},
    // user options
    ...options,
  };

  if (!opts.modname) {
    opts.modname = Path.basename(opts.outfile, Path.extname(opts.outfile));
  }

  if (!('DEBUG' in opts.globalDefs)) {
    opts.globalDefs['DEBUG'] = !!opts.debug;
  }

  if (opts.target) {
    let defs = targetDefs(opts.target);
    Object.keys(defs).forEach(k => {
      if (!(k in opts.globalDefs)) {
        opts.globalDefs[k] = defs[k];
      }
    });
  }

  return rollupWrapper(c, opts)
    .then(r => {
      // dlog({ "map.sources": r.map.sources, imports: r.imports, exports: r.exports })
      return compileBundle(opts, r.code, r.map.toString() /*, r.exportAll*/);
    })
    .catch(err => {
      let file = err.filename || (err.loc && err.loc.file) || null;
      let line = err.line || (err.loc && err.loc.line) || 0;
      let col = err.col || err.column || (err.loc && err.loc.column) || 0;
      if (file) {
        if (Path.isAbsolute(file)) {
          let file1 = Path.relative(opts.projectdir, file);
          if (!file1.startsWith('../')) {
            file = file1;
          }
        }
        let msg = `${file}:${line}:${col}: ${err.message}`;
        if (err.frame && typeof err.frame == 'string') {
          msg += '\n' + err.frame;
        }
        let e = new Error(msg);
        e.name = 'PackageError';
        e.file = file;
        e.line = line;
        e.col = col;
        throw e;
      }
      throw err;
    });
}

let _defaultJsentryCJS = '';

function getDefaultJsentryCJS() {
  if (!_defaultJsentryCJS) {
    _defaultJsentryCJS = defaultJsentry.replace(
      /export default/,
      'module.exports ='
    );
  }
  return _defaultJsentryCJS;
}

const nodeJsLibs = [
  // nodejs builtins
  'assert',
  'globals',
  'readline',
  'async_hooks',
  'http',
  'repl',
  'base',
  'http2',
  'stream',
  'buffer',
  'https',
  'string_decoder',
  'child_process',
  'index',
  'timers',
  'cluster',
  'inspector',
  'tls',
  'console',
  'module',
  'trace_events',
  'constants',
  'net',
  'tty',
  'crypto',
  'os',
  'url',
  'dgram',
  'path',
  'util',
  'dns',
  'perf_hooks',
  'v8',
  'domain',
  'process',
  'vm',
  'events',
  'punycode',
  'worker_threads',
  'fs',
  'querystring',
  'zlib',
];

function rollupWrapper(c, opts) {
  if (!opts.jsentryfile) {
    return Promise.resolve({
      code: opts.esmod ? defaultJsentry : getDefaultJsentryCJS(),
      map: '{"version":3,"sources":["wasmc:default"],"mappings":""}',
      // exportAll: true,
    });
  }

  // do not try to embed these libraries
  let externalLibs =
    opts.target == 'node' || opts.target == 'node-legacy' ? nodeJsLibs : [];

  // TODO: consider searching for a package.json and add libraries in
  // the "dependencies" list, e.g.
  // ...Object.keys(pkg.dependencies || {}),

  const rollupOptions = {
    input: opts.jsentryfile,
    external: externalLibs.slice(),
    onwarn(m) {
      if (m.importer) {
        c.warn(`${m.importer}: ${m.message}`);
      } else {
        c.warn(m.message);
      }
    },
  };
  return rollup.rollup(rollupOptions).then(r => {
    return r.generate({
      format: opts.esmod ? 'es' : 'cjs',
      sourcemap: true,
      sourcemapExcludeSources: true,
      // sourcemapFile: 'bob',
      // name: modname,
      // banner: '((Module)=>{',
      // footer: '})()',
    });
  });
}

const ast = uglify.ast;

// mkvardef(varcons :{new(props)=>ast.Node}, nameAndValues : string[][])
function mkvardef(varcons, nameAndValues) {
  let definitions = [];
  for (let [name, value] of nameAndValues) {
    if (!(name instanceof ast.Symbol)) {
      name = new ast.SymbolVar({
        name: String(name),
      });
    }
    if (value === null && value === undefined) {
      value = null;
    } else if (!(value instanceof ast.Node)) {
      value = new ast.String({
        value: String(value),
        quote: '"',
      });
    }
    definitions.push(new ast.VarDef({ name, value }));
  }
  return new varcons({ definitions });
}

let stripTopLevelFunDefs = new Set(
  [
    // we provide our own versions of these
    'assert',
    'abort',
  ].filter(v => !!v)
);

let stripTopLevelFunDefsPrefix = new Set(['nullFunc_']);

const stripTopLevelVarDefs = new Set([
  // we provide our own versions of these
  'out',
  'err',
]);

const wasmcSourceFileNames = {
  '<wasmcpre>': 1,
  '<wasmcmid>': 1,
  '<wasmcpost>': 1,
};

// let stripDefsWithName = new Set([
//   // !opts.debug ? 'err' : null,
// ].filter(v => !!v))

function shouldStripTopLevelFunNamed(name, file) {
  if (file in wasmcSourceFileNames) {
    // never strip stuff from our pre and post code
    return false;
  }
  if (stripTopLevelFunDefs.has(name)) {
    // console.log(`strip fun ${name} (by name) file ${file}`)
    return true;
  }
  for (let prefix of stripTopLevelFunDefsPrefix) {
    if (name.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

// set to print debugging info about AST transformation
const DEBUG_AST_TR = DEBUG && false;

function transformEmccAST(opts, toplevel) {
  let updateAPIFun = null;
  let ModuleObj = null;
  let didAddImports = false;

  const dummyLoc = { file: '<wasmpre>', line: 0, col: 0 };

  let stack = [toplevel];
  let parent = toplevel;
  let dbg = DEBUG_AST_TR
    ? function () {
        console.log(
          '[tr]' +
            '                                                        '.substr(
              0,
              stack.length * 2
            ),
          ...arguments
        );
      }
    : function () {};

  let visited = new Set();

  let newTopLevel = toplevel.transform(
    new uglify.TreeTransformer(function (node, descend1, inList) {
      if (visited.has(node)) {
        return node;
      }
      visited.add(node);

      function descend(n, ctx) {
        dbg(`> ${n.TYPE}`);
        stack.push(node);
        parent = node;
        let res = descend1(n, ctx);
        stack.pop(node);
        parent = stack[stack.length - 1];
        // dbg(`descend return-from ${n.TYPE}`)
        return res;
      }

      // dbg("visit", node.TYPE)

      if (node instanceof ast.Toplevel) {
        return descend(node, this);
      }

      let parentIsToplevel = parent.TYPE == 'Toplevel';

      if (parentIsToplevel && node instanceof ast.Var) {
        for (let i = 0; i < node.definitions.length; i++) {
          let def = node.definitions[i];
          if (!def.name) {
            continue;
          }
          let name = def.name.name;

          if (name in opts.globalDefs) {
            // overridden by -D flag -- remove local definition in favor of global definition
            dbg(`strip var def ${name} in ${def.start.file} (global override)`);
            node.definitions.splice(i, 1);
          } else if (stripTopLevelVarDefs.has(name)) {
            dbg(`strip var def ${name} in ${def.start.file} (wasmc)`);
            return new ast.EmptyStatement();
          } else if (
            name.startsWith('real_') &&
            def.value.TYPE == 'Sub' &&
            def.value.expression.name == 'asm'
          ) {
            // e.g. var real__hello = asm["hello"];
            // dbg(def.value.TYPE, def.value.property.value)
            return new ast.EmptyStatement();
          }
        }

        if (node.definitions.length === 0) {
          return new ast.EmptyStatement();
        }
      } // if parentIsToplevel && node instanceof ast.Var
      else if (
        node instanceof ast.SimpleStatement &&
        node.body instanceof ast.Assign &&
        node.body.operator == '='
      ) {
        // assignment
        let { right, left } = node.body;

        if (
          parentIsToplevel &&
          left.TYPE == 'Sub' &&
          left.expression.name == 'asm' &&
          right.TYPE == 'Function'
        ) {
          // e.g.
          //   asm["hello"] = function() {
          //     return real__hello.apply(null, arguments);
          //   };
          return new ast.EmptyStatement();
        }

        if (left.TYPE == 'SymbolRef') {
          // case: NAME = <right>
          if (left.name in opts.globalDefs) {
            // overridden by -D flag -- remove local definition in favor of global definition
            // dbg(`strip use of gdef assignment ${left.name} in ${left.start.file}`,
            //   {parent:parent.TYPE})
            if (DEBUG && parent.TYPE != 'Toplevel') {
              console.log(
                'TODO: transformer: gdef assignment sub at non-top level'
              );
            }
            return new ast.EmptyStatement();
          }
        }
      } // assignment
      else if (parentIsToplevel && node instanceof ast.Defun && node.name) {
        // Function definition

        let name = node.name.name;
        // console.log("FunDef >>", name)

        if (name == '__wasmcUpdateAPI') {
          // Save reference to __wasmcUpdateAPI function (patched later)
          updateAPIFun = node;
        } else if (
          shouldStripTopLevelFunNamed(name, node.start && node.start.file)
        ) {
          // console.log(`strip fun`, name, node.start)
          // node.argnames = []
          // node.body = []
          // node.start = undefined
          // node.end = undefined
          return new ast.EmptyStatement();
        } else if (name == 'run') {
          // I.e.
          //   function run(args) { ...
          // Add "__wasmcUpdateAPI()" to body
          //dlog("FunDef >>", name)
          let insertIndex = 0;
          for (let i = 0; i < node.body.length; i++) {
            let cn = node.body[i];
            if (cn instanceof ast.If) {
              // insert after
              //   if (runDependencies > 0) {
              //     return;
              //   }
              insertIndex = i + 1;
              break;
            } else {
              //dlog("**", cn.TYPE)
            }
          }
          node.body.splice(
            insertIndex,
            0,
            new ast.SimpleStatement({
              body: new ast.Call({
                args: [],
                expression: new ast.SymbolVar({ name: '__wasmcUpdateAPI' }),
              }),
            })
          );
        }
      } // top-level defun with name, e.g. function foo() { ... }
      else if (parentIsToplevel && node instanceof ast.If) {
        // if (condition) ...

        if (
          node.condition.TYPE == 'SymbolRef' &&
          node.condition.name == 'ENVIRONMENT_IS_NODE' &&
          node.body.TYPE == 'BlockStatement'
        ) {
          // if (ENVIRONMENT_IS_NODE) { ... }
          //
          // Strip all `process.on` calls, e.g.
          //   process["on"]("uncaughtException", function(ex) { ... });
          //   process["on"]("unhandledRejection", abort);
          node.body.body = node.body.body.filter(
            n =>
              n.TYPE != 'SimpleStatement' ||
              n.body.TYPE != 'Call' ||
              n.body.expression.TYPE != 'Sub' ||
              n.body.expression.expression.name != 'process' ||
              n.body.expression.property.value != 'on'
          );
        } else if (
          node.condition.operator == '!' &&
          node.condition.expression.TYPE == 'Call' &&
          node.condition.expression.expression.property ==
            'getOwnPropertyDescriptor' &&
          node.condition.expression.args.length > 1 &&
          node.condition.expression.args[0].TYPE == 'SymbolRef' &&
          node.condition.expression.args[0].name == 'Module'
        ) {
          // Strip
          // if (!Object.getOwnPropertyDescriptor(Module, "ENV")) Module["ENV"] = function() {
          //   abort("'ENV' was not exported. add it to EXTRA_EXPORTED_RUNTIME_METHODS");
          // };
          return new ast.EmptyStatement();
        }
      } // if (condition) ...

      // else console.log(node.TYPE)

      return node;
      // return descend(node, this)
    }) // uglify.TreeTransformer
  ); // newTopLevel = toplevel.transform

  // console.time("figure_out_scope()")
  // newTopLevel.figure_out_scope()
  // console.timeEnd("figure_out_scope()")
  // // console.log(Object.keys(newTopLevel))
  // console.log("_hello:", newTopLevel.variables._values["$_hello"].references.length)
  // // newTopLevel.variables._values["$_malloc"].references[0].TYPE == SymbolRef
  // // console.log("_malloc:", newTopLevel.variables._values["$_malloc"].references.length)
  // // console.log("_setThrew:", newTopLevel.variables._values["$_setThrew"])

  return { ast: newTopLevel };
}

/*
function wrapInCallClosure0(node) {
  let body = node.body;
  node.body = [
    new ast.SimpleStatement({
      body: new ast.Call({
        args: [],
        expression: new ast.Arrow({
          argnames: [],
          uses_arguments: false,
          is_generator: false,
          async: false,
          body: body,
        }),
      }),
    }),
  ];
  return node;
}

function wrapInCallClosure(node) {
  return node.transform(
    new uglify.TreeTransformer(function (n, descend, inList) {
      if (n === node) {
        return wrapInCallClosure0(n);
      }
      return n;
    })
  );
}

function wrapSingleExport(node, localName, exportName) {
  // example
  // input:
  //   var localName = 1
  // output:
  //   var exportName = (() => {
  //     var localName = 1
  //     return localName
  //   })()
  //
  node.body.push(
    new ast.Return({
      value: new ast.SymbolVar({ name: localName }),
    })
  );

  wrapInCallClosure0(node);

  node.body[0] = mkvardef(ast.Const, [[exportName, node.body[0]]]);

  return node;
}
*/

function getModuleEnclosure(opts) {
  let preRun = '',
    postRun = '';

  // let performTiming = opts.debug
  // if (performTiming) {
  //   let label = JSON.stringify(opts.modname + ' module-init')
  //   preRun = `()=>{console.time(${label})}`
  //   postRun = `()=>{console.timeEnd(${label})}`
  // }

  let targetsNode = opts.target == 'node' || opts.target == 'node-legacy';

  // snippet added to Module when -syncinit is set
  let instantiateWasm = opts.syncinit
    ? `
    instantiateWasm(info, receiveInstance) {
      let instance = new WebAssembly.Instance(
        new WebAssembly.Module(getBinary(wasmBinaryFile)), info)
      receiveInstance(instance)
      return instance.exports
    },
  `
        .trim()
        .replace(/^\s\s/g, '')
    : '';

  let pre = '';

  if (opts.debug) {
    // define globals as variables
    pre +=
      'const ' +
      Object.keys(opts.globalDefs)
        .map(k => `${k} = ${JSON.stringify(opts.globalDefs[k])}`)
        .join(',') +
      ';\n';
  }

  let printJs = opts.noconsole
    ? `emptyfun`
    : opts.debug
    ? `console.log.bind(console,'[${opts.modname}]')`
    : `console.log.bind(console)`;
  let printErrJs = opts.noconsole
    ? `emptyfun`
    : opts.debug
    ? `console.error.bind(console,'[${opts.modname}]')`
    : `console.error.bind(console)`;

  let assertFunJs = opts.debug
    ? `
    function assert(condition, message) {
      if (!condition) {
        let e = new Error(message || "assertion failed")
        e.name = "AssertionError"
        throw e
      }
    }
    `
        .trim()
        .replace(/^\s{4}/g, '')
    : `function assert() {}`;

  let errNotInitializedFun =
    opts.debug && !opts.syncinit
      ? `function errNotInitialized() { ` +
        `throw new Error(` +
        `"you need to wait for the module to be ready (use the Module.ready Promise)");` +
        `}\n`
      : ``;

  let onRuntimeInitializedExtra = opts.esmod
    ? `let e = ${targetsNode ? 'orig_module.exports' : '{}'};`
    : `let e = exports;` +
      `if (typeof define == 'function') {` +
      `define(${JSON.stringify(opts.modname)}, e);` +
      `}`;

  pre +=
    `

  var WASMC_IS_NODEJS_LIKE = (
    typeof process === "object" &&
    typeof process.versions === "object" &&
    typeof process.versions.node === "string" &&
    typeof require === "function"
  )
  let PathModule
  if (WASMC_IS_NODEJS_LIKE) {
    try { PathModule = require('path') } catch(_) {}
  }

  // clear module to avoid emcc code to export THE ENTIRE WORLD
  var orig_module
  if (typeof module != 'undefined') {
    orig_module = module
    module = undefined
  }

  function emptyfun() {}

  function abort(e) {
    throw new Error("wasm abort" + (e ? ": " + (e.stack||e) : ""))
  }

  ${assertFunJs}
  ${errNotInitializedFun}

  function __wasmcUpdateAPI() {}

  var Module = {
    preRun: [${preRun}],
    postRun: [${postRun}],
    print:    ${printJs},
    printErr: ${printErrJs},
    ${instantiateWasm}
    ${opts.embed ? 'wasmBinary: WASM_DATA,' : ''}
  }

  Module.ready = new Promise(resolve => {
    Module.onRuntimeInitialized = () => {
      ${onRuntimeInitializedExtra}
      resolve(e)
    }
  })

  if (WASMC_IS_NODEJS_LIKE && PathModule) {
    Module.locateFile = function(name) {
      return PathModule.join(__dirname, name)
    }
  }

  // make print function available in module namespace
  const print = ${opts.noconsole ? 'emptyfun' : `Module.print`};
  let out = ${opts.nostdout ? 'emptyfun' : `print`};
  let err = ${opts.noconsole || opts.nostderr ? 'emptyfun' : `Module.printErr`};

  `
      .trim()
      .replace(/^\s{2}/g, '') + '\n';

  let mid = `

  Module.inspect = () => "[asm]"

  // Restore temporarily nulled module variable
  if (orig_module !== undefined) {
    module = orig_module
    orig_module = undefined
  }

  `
    .trim()
    .replace(/^\s{2}/g, '');

  let post = ``;

  return { pre, mid, post };
}

function getEmccFileSource(opts) {
  let js = fs.readFileSync(opts.emccfile, 'utf8');
  if (opts.wasmfile) {
    let m = /\bwasmBinaryFile\s*=\s*(?:'([^']+)'|"([^"]+)");?/g.exec(js);
    if (!m) {
      throw new Error(
        `wasmc failed to find wasmBinaryFile in EMCC output file ${opts.emccfile}`
      );
    }
    js =
      js.substr(0, m.index) +
      `var wasmBinaryFile = ${JSON.stringify(opts.wasmfile)}` +
      js.substr(m.index + m[0].length);
  }
  return js;
}

export function gen_WASM_DATA(buf, target) {
  if (target == 'node' && NODE_VERSION_GTE_11_7) {
    // Compress WASM data using brotli.
    // This not only yields drastically smaller files, but speeds up initialization as well.
    // disable by setting target="node-legacy" or target=null.
    buf = brotliCompressSync(buf);
    return (
      'require("node:zlib").brotliDecompressSync(Buffer.from(' +
      JSON.stringify(buf.toString('base64')) +
      ',"base64"));'
    );
    // return (
    //   'require("zlib").brotliDecompressSync(new Uint8Array([' +
    //   Array.prototype.join.call(buf, ",") +
    //   ']));'
    // )
  }
  return 'new Uint8Array([' + Array.prototype.join.call(buf, ',') + ']);';
}

function compileBundle(opts, wrapperCode, wrapperMapJSON /*, exportAll*/) {
  let wrapperStart = opts.esmod ? '' : `(function(exports){"use strict";\n`;

  const wrapperEnd = opts.esmod
    ? ''
    : `})(typeof exports!='undefined'?exports:this["${opts.modname}"]={})`;

  const enclosure = getModuleEnclosure(opts);

  if (opts.embed) {
    let emccfile = opts.emccfile;
    let wasmfile = stripext(emccfile) + '.wasm';
    let buf = fs.readFileSync(wasmfile);
    wrapperStart += 'const WASM_DATA = ' + gen_WASM_DATA(buf, opts.target);
  }

  let pretty = opts.pretty || opts.debug;

  let options = {
    ecma: opts.ecma,
    toplevel: !opts.debug,
    compress: opts.debug
      ? false
      : {
          global_defs: opts.globalDefs,
          passes: 2,
          toplevel: true,
          top_retain: ['exports'],
          hoist_vars: true,
          keep_classnames: true,
          dead_code: true,
          evaluate: true,
          drop_console: opts.noconsole,
          pure_funcs: ['getNativeTypeSize'],
        },
    mangle: pretty
      ? false
      : {
          toplevel: true,
          keep_classnames: true,
          // reserved: [],
          // keep_quoted: true,
        },
    output: {
      beautify: pretty,
      indent_level: 2,
      preamble: wrapperStart,
      comments: !!opts.debug,
    },
    sourceMap: opts.nosourcemap
      ? false
      : {
          content: wrapperMapJSON,
        },
  };

  // Explicitly parse source files in order since order matters.
  // Note: uglify.minify takes an unordered object for muliple files.
  let srcfiles = [
    enclosure.pre && ['<wasmcpre>', enclosure.pre],
    [opts.emccfile, getEmccFileSource(opts)],
    enclosure.mid && ['<wasmcmid>', enclosure.mid],
    [opts.jsentryfile, wrapperCode],
    enclosure.post && ['<wasmcpost>', enclosure.post],
  ].filter(v => !!v);

  options.parse = options.parse || {};
  options.parse.toplevel = null;
  for (let [name, source] of srcfiles) {
    options.parse.filename = name;
    options.parse.toplevel = uglify.parse(source, options.parse);
    if (name == opts.emccfile) {
      let tr = transformEmccAST(opts, options.parse.toplevel);
      options.parse.toplevel = tr.ast;
      // options.parse.toplevel = wrapInCallClosure(options.parse.toplevel)
      // options.parse.toplevel = wrapSingleExport(
      //   options.parse.toplevel,
      //   'asm',
      //   'asm'
      // )
    }

    // [wasmc_imports start]
    // else if (name == jsentryfile) {
    //   let toplevel2 = transformUserAST(jsentryfile, options.parse.toplevel)
    //   if (!toplevel2) {
    //     // There were errors
    //     process.exit(1)
    //   }
    //   options.parse.toplevel = toplevel2
    // }
    // [wasmc_imports end]
  }

  let r;
  if (!opts.debug) {
    // roundtrip transformed code since there's either a bug in uglify-es with scope
    // resolution, or I just can't figure out how to make it see references to vars.
    r = uglify.minify(options.parse.toplevel, {
      toplevel: true,
      compress: false,
      mangle: false,
      output: {},
      sourceMap: opts.nosourcemap
        ? false
        : {
            content: wrapperMapJSON,
          },
    });
    r = uglify.minify(
      { a: r.code },
      {
        ...options,
        sourceMap: opts.nosourcemap
          ? false
          : {
              content: r.map,
            },
      }
    );
  } else {
    r = uglify.minify(options.parse.toplevel, options);
  }

  if (r.error) {
    throw new Error('uglify: ' + r.error);
  }

  let code = r.code + wrapperEnd;
  let sourcemap = '';

  // source map
  if (!opts.nosourcemap) {
    let map = JSON.parse(r.map);
    delete map.sourcesContent;
    map.sourceRoot = '..';
    sourcemap = JSON.stringify(map);

    let mapurl = '';
    if (opts.inlineSourcemap) {
      mapurl =
        'data:application/json;charset=utf-8;base64,' +
        Buffer.from(sourcemap, 'utf8').toString('base64');
      sourcemap = '';
    } else if (opts.sourcemapFile) {
      mapurl = opts.sourcemapFile;
    } else {
      mapurl = Path.basename(opts.outfile + '.map');
    }
    code += `\n//# sourceMappingURL=${mapurl}\n`;
  }

  // fs.writeFileSync(opts.outfile, code, 'utf8')
  return { code, sourcemap };
}
