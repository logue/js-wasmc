
/*import { assert, dlog, writefileSync, globv, stripext } from "./util"

const fs = require("fs")
const Path = require("path")
const vm = require("vm")


class Config {
  rebuildLibMap() {
    this.libmap = {}
    for (let lib of this.clibs) {
      this.libmap[lib.name] = lib
    }
  }
}

class Lib {
  getSourceFiles() {
    if (this._expandedSources === undefined) {
      this._expandedSources = globv(this.sources.map(fn =>
        Path.resolve(this.config.projectdir, fn))
      )
    }
    return this._expandedSources
  }
}

class Mod {
  get outfilejs() {
    return this._outfilejs || (this._outfilejs =
      Path.resolve(this.config.projectdir, this.out)
    )
  }
  get outfilewasm() {
    return this._outfilewasm || (this._outfilewasm =
      Path.resolve(this.config.projectdir, stripext(this.out) + ".wasm")
    )
  }
}


// Returns configuration + { didConfigure:bool }
//
// configure(c :Context, configfile :string|null, projectdir:string|null, argv:string[])
//
export function configure(c, configfile, projectdir, argv) {
  // sort out projectdir and configfile
  if (!projectdir) {
    if (configfile) {
      projectdir = Path.dirname(Path.resolve(configfile))
    } else {
      projectdir = process.cwd()
    }
  } else {
    projectdir = Path.resolve(projectdir)
  }

  if (!configfile) {
    configfile = "wasmc.js"
  }

  let config = { __proto__: Config.prototype,
    // default configuration

    file:       configfile,
    projectdir: projectdir,
    debug:      c.debug,
    builddir:   c.debug ? 'build/debug' : 'build/release',
    ninjafile:  "",
    argv:       argv,

    // flags used for both comppiling source files and linking
    flags: [
      '-std=c11',
      '-fcolor-diagnostics',  // enable ANSI color output when attached to a TTY
    ],

    // flags used when linking, in addition to `flags`
    lflags: [
      // Emscripten specific (ASM.JS/WASM)
      // '--llvm-lto', '0',
      // '--llvm-opts', '2',
      '-s', 'WASM=1',
      '-s', 'NO_EXIT_RUNTIME=1',
      '-s', 'NO_FILESYSTEM=1',
      '-s', 'ABORTING_MALLOC=0',
      '-s', 'ALLOW_MEMORY_GROWTH=1',
      '-s', 'DISABLE_EXCEPTION_CATCHING=1',
      '--js-opts', '0',
      '--closure', '0',
      '--minify', '0',
    ],

    // flags used when compiling source files, in addition to `flags`
    cflags: [
      '-fno-rtti',
      // '-fno-exceptions',
      '-ftemplate-backtrace-limit=0',
      '-Wall',
      '-Wno-shorten-64-to-32',
      '-Wno-unused-function',
      '-Wno-unused-parameter',
      '-Wno-unused-variable',
      '-Wno-null-conversion',
      '-Wno-c++11-extensions',
      // '-Wshadow',
      '-Wtautological-compare',
    ],

    clibs: [],
    modules: [],
    libmap: {},  // post processed from clibs; name => lib
  }

  if (c.debug) {
    config.lflags = config.lflags.concat([ '-s', 'DEMANGLE_SUPPORT=1' ])
    config.flags.push('-O0')
    config.flags.push('-g')
  } else {
    config.flags.push('-Oz')
    config.cflags.push('-DNDEBUG')
  }

  loadConfigFile(configfile, config)
  // console.log("config", JSON.stringify(config, null, 2))

  config.rebuildLibMap()

  if (!config.ninjafile) {
    config.ninjafile = Path.join(config.builddir, "build.ninja")
  }

  // header line written to ninja files
  // This is used to determine if a mtime up-to-date ninjafile needs to be regenerated
  // in case it was created by a different wasmc version, and thus this MUST be a single line.
  const ninjaLine1 = `# generated by wasmc ${WASMC_VERSION} [${c.debug ? "g" : "O"}]\n`

  // if the ninjafile exists and the configfile is older, then consider configuration up-to date.
  if (!c.force && checkNinjafileUpToDate(c, config.ninjafile, configfile, ninjaLine1)) {
    config.didConfigure = false
    return config
  }

  let ninjadata = generateNinjafile(c, config, ninjaLine1)
  writefileSync(config.ninjafile, ninjadata, "utf8")
  config.didConfigure = true

  return config
}


function generateNinjafile(c, config, ninjaLine1) {
  let s = ninjaLine1
  s += `ninja_required_version = 1.3\n`
  s += `\n`
  s += `outdir = .\n`
  s += `emcc = emcc\n`
  s += `flags =${fmtargs(config.flags, " $\n  ")}\n`
  s += `cflags = $flags${fmtargs(config.cflags, " $\n  ")}\n`
  s += `lflags = $flags${fmtargs(config.lflags, " $\n  ")}\n`
  s += `\n`
  s += `\n`
  s += `rule emcclink\n`
  s += `  command = $emcc $lflags $in -o $out\n`
  s += `  description = link $in -> $out\n`
  s += `\n`
  s += `rule emccobj\n`
  s += `  command = $emcc -MMD -MF $out.d $cflags $in -c -o $out\n`
  s += `  description = $emcc $in -> $out\n`
  s += `  depfile = $out.d\n`
  s += `\n`
  s += `\n`

  let builddirabs = Path.resolve(config.builddir)
  let objfilesByDep = new Map()  // depname => string[]
  let objfileMap = new Map()  // srcfile + key(extras) => objfile
  let extrasSet = new Set()
  let defaultTarget = ""


  function gen_build_objfile(srcfile, extras, extrasKey) {
    let lookupKey = extrasKey + srcfile
    let ofile = objfileMap.get(lookupKey)
    if (!ofile) {

      ofile = Path.relative(config.projectdir, srcfile).replace(/\//g, "__")
      if (ofile.startsWith("../")) {
        ofile = srcfile
      }
      ofile = `$outdir/obj/${extrasKey}${ofile}.bc`

      s += `build ${ofile}: emccobj ${buildpath(srcfile)}\n`
      s += extras

      objfileMap.set(lookupKey, ofile)
    }
    return ofile
  }


  // source files
  s += `# source files\n`
  for (let c of config.clibs) {
    let extras = ""
    let extrasKey = ""
    if (c.cflags && c.cflags.length) {
      extras = `  cflags = $cflags${fmtargs(c.cflags, " ")}\n`
      extrasKey = "__c" + extrasSet.size.toString(36) + "__"
    }

    let objfiles = []
    for (let srcfile of c.getSourceFiles()) {
      let objfile = gen_build_objfile(srcfile, extras, extrasKey)
      objfiles.push(objfile)
    }

    objfilesByDep.set(c.name, objfiles)
  }

  // modules
  for (let c of config.modules) {
    // dlog({c})

    let emccfile = `$outdir/${c.emccfile}`
    let wasmfile = `$outdir/${c.wasmfile}`

    let deps = []
    let miscdeps = []

    for (let depname of c.deps) {
      let depobjfiles = objfilesByDep.get(depname)
      if (!depobjfiles) {
        throw new Error(`wasm module ${c.name} specifies undefined dep: ${depname}`)
      }
      deps = deps.concat(depobjfiles)
    }

    if (c.jslib) {
      if (!c.lflags) {
        c.lflags = []
      }
      let fn = buildpath(c.jslib)
      c.lflags.push("--js-library")
      c.lflags.push(fn)
      miscdeps.push(fn)
    }

    s += `\n`
    s += `# module ${c.name}\n`
    s += `build ${wasmfile}: phony | ${emccfile}\n`
    s += `build ${emccfile}: emcclink $\n  ` + Array.from(new Set(deps)).join(" $\n  ")
    if (miscdeps.length > 0 ) {
      s += " $\n  | " + miscdeps.join(" $\n    ")
    }
    s += `\n`
    if (c.lflags && c.lflags.length) {
      s += `  lflags = $lflags${fmtargs(c.lflags, " ")}\n`
    }
  }

  // first module is default target
  if (config.modules.length > 0) {
    s += `\n`
    s += `default $outdir/${config.modules[0].wasmfile}\n`
  }


  // buildpath returns the most suitable file path to be used in the ninja file.
  // If filename is within projectdir then a path relative to builddir is returned,
  // otherwise an absolute path is returned.
  //
  function buildpath(filename) {
    filename = Path.resolve(filename)
    if (filename.startsWith(config.projectdir)) {
      return Path.relative(config.builddir, filename)
    }
    return filename
  }

  function fmtargs(args, sep) {
    return sep + args.join(sep)
  }

  return s
}


function checkNinjafileUpToDate(c, ninjafile, configfile, ninjaLine1) {
  let configfileStat = fs.statSync(configfile)
  let nst
  try {
    nst = fs.statSync(ninjafile)
    if (nst.mtimeMs < configfileStat.mtimeMs) {
      // configfile is newer than the ninjafile
      return false
    }
    if (nst.size < 200) {
      // ninjafile is too small. this can't be right
      return false
    }
  } catch (e) {
    if (e.code == "ENOENT") {
      return false  // ninjafile does not exist
    }
    throw e
  }
  // if we get here then the ninjafile is newer than the config file.
  // read first line of ninjafile and verify it was created by the current wasmc version
  let fd = fs.openSync(ninjafile, "r")
  try {
    let buf = Buffer.allocUnsafe(Math.min(nst.size, 100))
    let len = fs.readSync(fd, buf, 0, buf.length, null)
    let i = buf.indexOf(0xA)
    if (i == -1) {
      // can't fine line break
      return false
    }
    let line = buf.subarray(0, i+1).toString("utf8")
    if (line != ninjaLine1) {
      c.log(`ninjafile generated by different version of wasmc`)
      return false
    }
  } finally {
    fs.closeSync(fd)
  }
  return true
}


let autoNameCounter = 0


function loadConfigFile(filename, config) {
  // dlog("loadConfigFile", filename, config)
  let js = fs.readFileSync(filename, "utf8")

  // lib(sources :string|string[])
  // lib(props :CLibProps)
  function mklib(lib) {
    if (Array.isArray(lib)) {
      lib = { sources: lib }
    } else if (typeof lib == "string") {
      lib = { sources: [lib] }
    } else if (!lib.sources) {
      throw new Error(`missing "sources" list property in lib ${lib.name||""}`)
    } else if (!Array.isArray(lib.sources)) {
      lib.sources = [lib.sources]
    }
    if (!lib.name) {
      lib.name = `clib_${autoNameCounter++}`
    }
    lib.config = config
    lib.__proto__ = Lib.prototype
    config.clibs.push(lib)
    return lib
  }

  function lib(props) {
    return mklib(props).name
  }

  // module(props :ProductProps)
  function _module(props) {
    if (!props.name) {
      props.name = `wasm_mod_${autoNameCounter++}`
    }

    if (props.deps && !Array.isArray(props.deps)) {
      props.deps = [props.deps]
    }

    if (props.sources) {
      // create a lib
      let clib = mklib(props.sources)
      if (!props.deps) {
        props.deps = []
      }
      if (props.cflags) {
        clib.cflags = props.cflags
        delete props.cflags
      }
      delete props.sources
      props.deps.push(clib.name)
    }

    if (!props.deps || props.deps.length == 0) {
      throw new Error(`no sources or deps specified for module ${props.name}`)
    }

    props.emccfile = `obj/${props.name}.js`
    props.wasmfile = `obj/${props.name}.wasm`

    if (!props.out) {
      props.out = Path.join(config.builddir, props.name + ".js")
    }

    props.__proto__ = Mod.prototype
    props.config = config
    config.modules.push(props)
    return props.name
  }

  let env = {
    ...config,
    lib,
    module: _module,
  }
  vm.createContext(env)
  vm.runInContext(js, env, { filename })
  // copy known keys from env to config
  for (let k in env) {
    if (k in config) {
      config[k] = env[k]
    }
  }
  return config
}
*/
