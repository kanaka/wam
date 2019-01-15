#!/usr/bin/env node

// Copyright Joel Martin <github@martintribe.org>
// Licensed under MPL-2.0 (see ./LICENSE)
// https://github.com/kanaka/wam

"use strict"

const assert = require('assert')

function nth_word(tokens, nth) {
    if (nth < 0) {
        let word_cnt = tokens.words().length
        nth = word_cnt + nth
    }
    let word_idx = 0
    for (let tok_idx = 0; tok_idx < tokens.length; tok_idx++) {
        let a = tokens.get(tok_idx)
        if (a instanceof Whitespace) {
            // no-op
        } else if (word_idx === nth) {
            return [tok_idx, a]
        } else {
            word_idx += 1
        }
    }
    return [tokens.length-1, null]
}

function _escape(s) {
    return s.replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\x00/g, '\\00')
}

//
// Ast node types
//
class Node {
    constructor(val, start=[], end=[]) {
        this.val = val
        this.start = start
        this.end = end
    }
    surround(start, end) {
        this.start = start
        this.end = end
    }
}

class List extends Node {
    get length()  { return this.val.length }
    get(idx)      { return this.val[idx] }
    set(idx, val) { return this.val[idx] = val }
    map(f)        { return this.val.map(f) }
    slice(s,e)    { return this.val.slice(s,e) }
    filter(f)     { return this.val.filter(f) }
    words()       { return this.val.filter(t => !(t instanceof Whitespace)) }
}

class Splice extends List { }

class Whitespace extends Node { }
class Name extends Node { }
class Literal extends Node { }
class Str extends Node { }
class Integer extends Node { }
class Float extends Node { }

//
// Token reader
//
class Reader {
    constructor(tokens, position=0) {
        this.tokens = tokens
        this.position = position
        this.line = 0
    }

    next() { return this.tokens[this.position++] }
    peek() { return this.tokens[this.position] }
}

//
// Parsing
//

let tok_re = /([\s][\s]*|[(];.*?;[)]|[\[\]{}()`~^@]|'(?:[\\].|[^\\'])*'?|"(?:[\\].|[^\\"])*"?|;;.*|[^\s\[\]{}()'"`@,;]+)/g
let space_re = /^([\s]+|;;.*|[(];.*)$/
let int_re = /^-?[0-9xa-fA-F]+$/
let float_re = /^-?[0-9][0-9.]*$/

function tokenize(str) {
    let results = []
    let match
    while (match = tok_re.exec(str)) {
        if (match[1] === '') { break }
        results.push(match[1])
    }
    return results;
}

function is_whitespace(tok) {
    return space_re.exec(tok)
}

function read_whitespace(reader) {
    let res = []
    let tok = reader.peek()
    while (tok && is_whitespace(tok)) {
        res.push(new Whitespace(reader.next()))
        reader.line += (tok.match(/\n/) || []).length
        tok = reader.peek()
    }
    return res
}

function read_atom(reader) {
    let token = reader.next()
    if (token[0] === '$')           { return new Name(token) }
    else if (token[0] === '"')      { return new Str(token) }
    else if (token.match(int_re))   { return new Integer(token) }
    else if (token.match(float_re)) { return new Float(token) }
    else if (token.match(space_re)) { return new Whitespace(token) }
    else                            { return new Literal(token) }
}

function read_form(reader) {
    let token = reader.peek()
    if      (token.startsWith(';;')) { return token }
    else if (token.startsWith('(;')) { return token }
    else if (token === ')')          { throw Error("unexpected ')'") }
    else if (token === '(')          { return read_list(reader) }
    else                             { return read_atom(reader) }
}

function read_list(reader, start='(', end=')') {
    let lst = []

    let ws_start = read_whitespace(reader)
    let token = reader.next()

    while ((token = reader.peek()) !== end) {
        if (!token) { throw Error("expected '" + end + "', got EOF") }
        lst.push(read_form(reader))
        lst.push(...read_whitespace(reader))
    }
    reader.next()
    let ws_end = read_whitespace(reader)
    return new List(lst, ws_start, ws_end)
}

function read_str(str) {
    let tokens = tokenize(str)
    if (tokens.length === 0) { throw Error("Blank Line") }
    return read_list(new Reader(tokens))
}

//
// macros
//

function token_eval(val) {
    // Translate "\xFF" style unicode to "\uFFFF", then JSON parse it
    return JSON.parse(val.replace(/\\x([0-9A-Fa-f][0-9A-Fa-f])/g, '\\u00$1'))
}

// Short circuiting logical comparisons
function AND(args, ctx) {
    assert(args.length-1 > 0, "AND takes at least 1 argument")
    let res = new List([new Literal('i32.const'), new Integer(1)])
    for(let arg of args.slice(1).reverse()) {
        let a = wam_eval(arg, ctx)
        res = new List([new Literal('if'),
                        new List([new Literal('result'),
                                  new Literal('i32')]), a,
                                  res,
                                  new List([new Literal('i32.const'),
                                            new Integer(0)])])
    }
    return res
}

function OR(args, ctx) {
    assert(args.length-1 > 0, "OR takes at least 1 argument")
    let res = new List([new Literal('i32.const'), new Integer(0)])
    for (let arg of args.slice(1).reverse()) {
        let a = wam_eval(arg, ctx)
        res = new List([new Literal('if'),
                        new List([new Literal('result'),
                                  new Literal('i32')]), a,
                                  new List([new Literal('i32.const'),
                                            new Integer(1)]),
                                  res])
    }
    return res
}

function CHR(args, ctx) {
    assert(args.length-1 === 1, "CHR takes 1 argument")
    let arg1 = args[1].val
    let c = token_eval(arg1)
    if (c.length !== 1) {
        throw Error("Invalid CHR macro, must be 1 character string")
    }
    return read_str(`(i32.const 0x${c.charCodeAt(0).toString(16)} (; ${arg1} ;))`)
}

function STRING(args, ctx) {
    assert(args.length-1 === 1, "STRING takes 1 argument")
    let s = token_eval(args[1].val)
    let sname
    if (s in ctx.string_map) {
        // Duplicate string, re-use address
        sname = ctx.string_map[s]
    } else {
        sname = `$S_STRING_${ctx.strings.length}`
        ctx.strings.push([sname, s])
        ctx.string_map[s] = sname
    }
    return read_str(`(i32.add (get_global $memoryBase) (get_global ${sname}))`)
}

function STATIC_ARRAY(args, ctx) {
    assert(args.length-1 === 1, "STATIC_ARRAY takes 1 argument")
    let slen = parseInt(token_eval(args[1].val))
    let sname = `$S_STATIC_ARRAY_${ctx.strings.length}`
    ctx.strings.push([sname, slen])
    return read_str(`(i32.add (get_global $memoryBase) (get_global ${sname}))`)
}

function LET(args, ctx) {
    assert(args.length-1 >= 2, "LET takes at least 2 argument")
    assert((args.length-1) % 2 === 0, "LET takes even number of argument")
    let locals = []
    let sets = []
    for (let i = 1; i < args.length; i+=2) {
        let name = args[i]
        let res = wam_eval(args[i+1], ctx)
        res.surround([], [])
        locals.push(new List([new Literal('local'), name, new Literal('i32')]))
        sets.push(new List([new Literal('set_local'), name, res]))
    }
    // return a Splice so that it items get spliced in
    return new Splice(locals.concat(sets))
}

// wasm-as supports local and param forms with more than one
// definition but wat2wasm does not, so split these up.
function param_local(args, ctx) {
    let kind = args[0].val
    assert(args.length-1 >= 2, `${kind} takes at least 2 argument`)
    assert((args.length-1) % 2 === 0, `${kind} takes even number of argument`)
    let lst = []
    for (let i = 1; i < args.length; i+=2) {
        lst.push(new List([new Literal(kind), args[i], args[i+1]]))
    }
    // return a Splice so that it items get spliced in
    return new Splice(lst)
}

const macros = {
    'AND': AND,
    'OR': OR,
    'CHR': CHR,
    'STRING': STRING,
    'STATIC_ARRAY': STATIC_ARRAY,
    'LET': LET,
    'param': param_local,
    'local': param_local
}

//
// eval / macro expansion
//

const EMIT_HOIST_ORDER = ['import', 'global', 'table']
const EVAL_HOIST = new Set(EMIT_HOIST_ORDER)
const EVAL_NONE =  new Set(['memory', 'import', 'export', 'type',
                            'get_global', 'local', 'get_local',
                            'param', 'br', 'i32.const', 'i64.const',
                            'f32.const', 'f64.const'])
const EVAL_REST =  new Set(['module', 'func', 'memory', 'call',
                            'set_local', 'set_global', 'block',
                            'loop', 'br_if'])
const EVAL_LAST =  new Set(['global', 'br_table'])

function wam_eval(ast, ctx) {
    if (ast instanceof List) {
        let [a0idx, a0] = nth_word(ast, 0)
        let lst = []
        if (a0 instanceof Name) {
            // if first word is a $name, make it a call and evaluate the
            // rest of the list
            lst = ast.slice(a0idx+1).map(e => wam_eval(e, ctx))
            lst = [new Literal('call'), a0].concat(lst)
        } else if (a0 instanceof Literal && a0.val in macros) {
            // expand macros
            let res = macros[ast.get(0).val](ast.words().slice(a0idx), ctx)
            if (res instanceof Splice) {
                for (let r of res.slice()) { r.surround(ast.start, ast.end) }
            } else {
                res.surround(ast.start, ast.end)
            }
            return res
        } else if (a0 instanceof Literal && EVAL_HOIST.has(a0.val)) {
            // Hoist imports, globals, and table to the top
            // TODO: this shouldn't be necessary if wasm-as and/or
            // wat2wasm were compliant with the spec which indicates
            // that any ordering should be sufficient
            if (EVAL_LAST.has(a0.val))  {
                // eval last argument
                let [idx, a] = nth_word(ast, -1)
                ast.set(idx, wam_eval(a, ctx))
            }
            const comment_toks = ast.words().slice(0,3)
                .filter(a => !(a instanceof List))
                .map(a => a.val)
            let ws = new Whitespace(
                    `(; hoisted to top: ${comment_toks.join(' ')} ;)`)
            ws.surround(ast.start, ast.end)
            ast.surround([new Whitespace('  ')], [new Whitespace('\n')])
            let kind = ast.words()[0].val
            if (!(kind in ctx.hoist)) { ctx.hoist[kind] = [] }
            ctx.hoist[kind].push(ast)
            return ws
        } else if (a0 instanceof Literal && EVAL_NONE.has(a0.val)) {
            // don't eval arguments
            return ast
        } else if (a0 instanceof Literal && EVAL_REST.has(a0.val)) {
            // don't eval first argument if it's a name
            let [idx, a] = nth_word(ast, 1)
            if (a instanceof Name) {
                [idx, a] = nth_word(ast, 2)
            }
            lst = ast.slice(0, idx).concat(ast.slice(idx).map(
                        e => wam_eval(e, ctx)))
        } else if (a0 instanceof Literal && EVAL_LAST.has(a0.val)) {
            // only eval last argument
            let [idx, a] = nth_word(ast, -1)
            ast.set(idx, wam_eval(a, ctx))
            return ast
        } else {
            // evaluate all elements
            lst = ast.map(e => wam_eval(e, ctx))
        }
        let res_lst = []
        for (let l of lst) {
            if (l instanceof Splice) { res_lst.push(...l.slice()) }
            else                     { res_lst.push(l) }
        }
        return new List(res_lst, ast.start, ast.end)
    } else if (ast instanceof Str) {
        // Pass raw strings to the STRING macro
        return STRING([null, ast], ctx)
    } else if (ast instanceof Integer) {
        return new List([new Literal('i32.const'), ast])
    } else if (ast instanceof Float) {
        return new List([new Literal('f32.const'), ast])
    } else if (ast instanceof Name) {
        return new List([new Literal('get_local'), ast])
    } else {
        return ast
    }
}

//
// emit
//

function wam_emit(ast, ctx) {
    let toks = []
    // Prepend leading whitespace
    for (let a of ast.start) { toks.push(...wam_emit(a, ctx)) }
    if (ast instanceof List) {
        if (ast.words().length > 1 && ast.words()[0].val === 'module') {
            let mname = ast.words()[1].val.slice(1)
            ctx.modules.push(mname)
            toks.push(`;; module $${mname}\n`)
            let mode = 'skip'
            for (let a of ast.slice()) {
                // skip module and module name
                if (mode === 'skip') {
                    if (a instanceof List) {
                        mode = 'continue'
                    } else if (a instanceof Literal && a.val === 'module') {
                        continue
                    } else if (a instanceof Name) {
                        continue
                    }
                }
                toks.push(...wam_emit(a, ctx))
            }
        } else {
            toks.push('(')
            for (let a of ast.slice()) {
                let r = wam_emit(a, ctx)
                // add whitespace between list items if needed
                if (toks[toks.length-1] !== '('
                        && !is_whitespace(toks[toks.length-1])
                        && !is_whitespace(r[0])) {
                    toks.push(' ')
                }
                toks.push(...r)
            }
            toks.push(')')
        }
    } else if (ast instanceof Integer || ast instanceof Float) {
        toks.push(ast.val.toString())
    } else if (typeof(ast.val) === "string") {
        toks.push(ast.val)
    } else {
        throw Error(`type ${typeof(ast.val)} has non-string val: ${ast.val}`)
    }
    // Append trailing whitespace
    for (let a of ast.end) { toks.push(...wam_emit(a, ctx)) }
    return toks
}

function emit_module(asts, ctx, opts) {
    // Create data section with static strings
    let strings = ctx.strings
    let string_tokens = []
    if (strings) {
        let slen
        // static string/array names/pointers
        let string_offset = 4  // skip first/NULL address (if memoryBase == 0)
        for (let [name, data] of strings) {
            if (typeof(data) === "number") {
                slen = data+1
            } else {
                slen = data.length+1
            }
            string_tokens.push(
                    `  (global ${name}  i32 (i32.const ${string_offset}))\n`)
            string_offset += slen
        }

        // Terminator so we know how much memory we took
        string_tokens.push(
                `  (global $S_STRING_END  i32 (i32.const ${string_offset}))\n\n`)

        // static string/array data
        string_tokens.push(`  (data\n    (get_global $memoryBase)\n`)
        string_tokens.push(`    "\\de\\ad\\be\\ef" ;; skip first/NULL address\n`)
        string_offset = 4  // skip first/NULL address (if memoryBase == 0)
        for (let [name, data] of strings) {
            let sdata
            if (typeof(data) === "number") {
                sdata = ("\x00".repeat(data))
            } else {
                sdata = data
            }
            slen = sdata.length+1
            let escaped = '"'+(_escape(sdata)+'\\00"').padEnd(29)
            string_tokens.push(`    ${escaped} ;; ${string_offset}\n`)
            string_offset += slen
        }
        string_tokens.push(`  )\n\n`)
    }


    let mod_tokens = asts.map(a => wam_emit(a, ctx))
    let hoist_tokens = []
    //console.warn(ctx.hoist)
    for (let kind of EMIT_HOIST_ORDER) {
        //console.warn(kind, ctx.hoist[kind])
        if (!ctx.hoist[kind]) { continue }
        hoist_tokens.push(...ctx.hoist[kind].map(a => wam_emit(a, ctx)))
    }

    let all_tokens = [
        `(module $${(ctx.modules).join('__')}\n\n`,
        `  (import \"env\" \"memory\" (memory ${opts.memorySize}))\n`,
        `  (import \"env\" \"memoryBase\" (global $memoryBase i32))\n\n`
    ]
    // Hoisted global defintions
    all_tokens.push(...[].concat.apply([], hoist_tokens), "\n")
    // Static string/array defintions and pointers
    all_tokens.push(...string_tokens, "\n")
    // Rest of the module
    all_tokens.push(...[].concat.apply([], mod_tokens), "\n)")

    //console.warn(all_tokens)
    return all_tokens.join("")
}

function empty_ctx() {
    return {
        'hoist': {},
        'strings': [],
        'string_map': {},
        'modules': []
    }
}

module.exports = {read_str, wam_eval, emit_module, empty_ctx}
