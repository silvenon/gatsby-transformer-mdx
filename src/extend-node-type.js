/* eslint-disable
  global-require,
  no-await-in-loop,
  no-param-reassign,
  no-restricted-syntax,
  no-use-before-define,
  import/newline-after-import,
  import/no-dynamic-require
*/
const {
  GraphQLObjectType,
  GraphQLList,
  GraphQLString,
  GraphQLInt,
  GraphQLEnumType,
  GraphQLJSON,
} = require('gatsby/graphql') // eslint-disable-line import/no-unresolved
const toMdAST = require('remark-parse')
const squeeze = require('remark-squeeze-paragraphs')
const toMdxAST = require('@mdx-js/mdxast')
const mdxAstToMdxHast = require('@mdx-js/mdx/mdx-ast-to-mdx-hast')
const { toJSX } = require('@mdx-js/mdx/mdx-hast-to-jsx')
const select = require('unist-util-select')
const sanitizeHTML = require('sanitize-html')
const _ = require('lodash')
const visit = require('unist-util-visit')
const toHAST = require('mdast-util-to-hast')
const hastToHTML = require('hast-util-to-html')
const mdastToToc = require('mdast-util-toc')
const Promise = require('bluebird')
const prune = require('underscore.string/prune')
const unified = require('unified')
const parse = require('remark-parse')
const stringify = require('remark-stringify')
const english = require('retext-english')
const remark2retext = require('remark-retext')
const stripPosition = require('unist-util-remove-position')
const hastReparseRaw = require('hast-util-raw')

let pluginsCacheStr = ''
let pathPrefixCacheStr = ''
const astCacheKey = node =>
  `transformer-mdx-markdown-ast-${
    node.internal.contentDigest
  }-${pluginsCacheStr}-${pathPrefixCacheStr}`
const jsxCacheKey = node =>
  `transformer-mdx-markdown-jsx-${
    node.internal.contentDigest
  }-${pluginsCacheStr}-${pathPrefixCacheStr}`
const mdxHastCacheKey = node =>
  `transformer-mdx-markdown-mdx-hast-${
    node.internal.contentDigest
  }-${pluginsCacheStr}-${pathPrefixCacheStr}`
const headingsCacheKey = node =>
  `transformer-mdx-markdown-headings-${
    node.internal.contentDigest
  }-${pluginsCacheStr}-${pathPrefixCacheStr}`
const tableOfContentsCacheKey = node =>
  `transformer-mdx-markdown-toc-${
    node.internal.contentDigest
  }-${pluginsCacheStr}-${pathPrefixCacheStr}`

// ensure only one `/` in new url
const withPathPrefix = (url, pathPrefix) =>
  (pathPrefix + url).replace(/\/\//, '/')

/**
 * Map that keeps track of generation of AST to not generate it multiple
 * times in parallel.
 *
 * @type {Map<string,Promise>}
 */
const ASTPromiseMap = new Map()

module.exports = (
  { type, store, pathPrefix, getNode, cache, reporter },
  // eslint-disable-next-line no-unused-vars
  { remarkPlugins = [], rehypePlugins = [], compilers = [], ...pluginOptions },
) => {
  if (type.name !== 'MarkdownRemark') {
    return {}
  }

  pluginsCacheStr = remarkPlugins.map(plugin => plugin.name).join('')
  pathPrefixCacheStr = pathPrefix || ''

  return new Promise(async resolve => {
    const mdxAstCompiler = unified()
      .use(toMdAST, {
        commonmark: true,
        footnotes: true,
        pedantic: true,
        ...pluginOptions,
      })
      .use(squeeze, pluginOptions)

    const applyPlugins = plugins => {
      for (const plugin of plugins) {
        const requiredPlugin = require(plugin.resolve)
        if (_.isFunction(requiredPlugin.setParserPlugins)) {
          for (const parserPlugin of requiredPlugin.setParserPlugins(
            plugin.pluginOptions,
          )) {
            if (_.isArray(parserPlugin)) {
              const [parser, options] = parserPlugin
              mdxAstCompiler.use(parser, options)
            } else {
              mdxAstCompiler.use(parserPlugin)
            }
          }
        }
      }
    }

    applyPlugins(remarkPlugins)
    mdxAstCompiler.use(toMdxAST)

    async function getAST(markdownNode) {
      const cacheKey = astCacheKey(markdownNode)
      const cachedAST = await cache.get(cacheKey)

      if (cachedAST) {
        return cachedAST
      }

      if (ASTPromiseMap.has(cacheKey)) {
        // We are already generating AST, so let's wait for it
        return ASTPromiseMap.get(cacheKey)
      }

      const ASTGenerationPromise = new Promise(async resolve => {
        let files = _.values(store.getState().nodes).filter(
          n => n.internal.type === 'File',
        )

        for (const plugin of remarkPlugins) {
          const requiredPlugin = require(plugin.resolve)
          if (_.isFunction(requiredPlugin.mutateSource)) {
            await requiredPlugin.mutateSource(
              {
                markdownNode,
                files,
                getNode,
                reporter,
                cache,
              },
              plugin.pluginOptions,
            )
          }
        }

        const ast = mdxAstCompiler.parse(markdownNode.internal.content)

        if (pathPrefix) {
          // Ensure relative links include `pathPrefix`
          visit(ast, 'link', node => {
            if (
              node.url &&
              node.url.startsWith('/') &&
              !node.url.startsWith('//')
            ) {
              node.url = withPathPrefix(node.url, pathPrefix)
            }
          })
        }

        // source => parse (can order parsing for dependencies) => typegen
        //
        // source plugins identify nodes, provide id, initial parse, know
        // when nodes are created/removed/deleted
        // get passed cached DataTree and return list of clean and dirty nodes.
        // Also get passed `dirtyNodes` function which they can call with an array
        // of node ids which will then get re-parsed and the inferred schema
        // recreated (if inferring schema gets too expensive, can also
        // cache the schema until a query fails at which point recreate the
        // schema).
        //
        // parse plugins take data from source nodes and extend it, never mutate
        // it. Freeze all nodes once done so typegen plugins can't change it
        // this lets us save off the DataTree at that point as well as create
        // indexes.
        //
        // typegen plugins identify further types of data that should be lazily
        // computed due to their expense, or are hard to infer graphql type
        // (markdown ast), or are need user input in order to derive e.g.
        // markdown headers or date fields.
        //
        // wrap all resolve functions to (a) auto-memoize and (b) cache to disk any
        // resolve function that takes longer than ~10ms (do research on this
        // e.g. how long reading/writing to cache takes), and (c) track which
        // queries are based on which source nodes. Also if connection of what
        // which are always rerun if their underlying nodes change..
        //
        // every node type in DataTree gets a schema type automatically.
        // typegen plugins just modify the auto-generated types to add derived fields
        // as well as computationally expensive fields.

        files = _.values(store.getState().nodes).filter(
          n => n.internal.type === 'File',
        )

        for (const plugin of remarkPlugins) {
          const requiredPlugin = require(plugin.resolve)
          if (_.isFunction(requiredPlugin)) {
            await requiredPlugin(
              {
                markdownAST: ast,
                markdownNode,
                getNode,
                files,
                pathPrefix,
                reporter,
                cache,
              },
              plugin.pluginOptions,
            )
          }
        }

        // Save new AST to cache and return
        cache.set(cacheKey, ast)
        // We can now release promise, as we cached result
        ASTPromiseMap.delete(cacheKey)
        resolve(ast)
      })
      ASTPromiseMap.set(cacheKey, ASTGenerationPromise)
      return ASTGenerationPromise
    }

    async function getHeadings(markdownNode) {
      const cachedHeadings = await cache.get(headingsCacheKey(markdownNode))
      if (cachedHeadings) {
        return cachedHeadings
      }
      const ast = await getAST(markdownNode)
      const headings = select(ast, 'heading').map(heading => ({
        value: _.first(select(heading, 'text').map(text => text.value)),
        depth: heading.depth,
      }))

      cache.set(headingsCacheKey(markdownNode), headings)
      return headings
    }

    async function getTableOfContents(markdownNode) {
      const cachedToc = await cache.get(tableOfContentsCacheKey(markdownNode))
      if (cachedToc) {
        return cachedToc
      }
      const ast = await getAST(markdownNode)
      const tocAst = mdastToToc(ast)

      let toc
      if (tocAst.map) {
        const addSlugToUrl = node => {
          if (node.url) {
            node.url = [pathPrefix, markdownNode.fields.slug, node.url]
              .join('/')
              .replace(/\/\//g, '/')
          }
          if (node.children) {
            node.children = node.children.map(node => addSlugToUrl(node))
          }

          return node
        }
        tocAst.map = addSlugToUrl(tocAst.map)

        toc = hastToHTML(toHAST(tocAst.map))
      } else {
        toc = ''
      }
      cache.set(tableOfContentsCacheKey(markdownNode), toc)
      return toc
    }

    async function getMdxHAST(markdownNode) {
      const cachedAst = await cache.get(mdxHastCacheKey(markdownNode))
      if (cachedAst) {
        return cachedAst
      }
      const ast = await getAST(markdownNode)
      const hast = mdxAstToMdxHast()(ast)

      // Save new HTML AST to cache and return
      cache.set(mdxHastCacheKey(markdownNode), hast)
      return hast
    }

    async function getJSX(markdownNode) {
      const cachedJSX = await cache.get(jsxCacheKey(markdownNode))
      if (cachedJSX) {
        return cachedJSX
      }
      const hast = await getMdxHAST(markdownNode)
      // Save new JSX to cache and return
      const jsx = `
        import React from 'react'
        import { MDXTag } from '@mdx-js/tag'
        ${toJSX(hast)}
      `

      // Save new JSX to cache and return
      cache.set(jsxCacheKey(markdownNode), jsx)
      return jsx
    }

    const HeadingType = new GraphQLObjectType({
      name: 'MarkdownHeading',
      fields: {
        value: {
          type: GraphQLString,
          resolve(heading) {
            return heading.value
          },
        },
        depth: {
          type: GraphQLInt,
          resolve(heading) {
            return heading.depth
          },
        },
      },
    })

    const HeadingLevels = new GraphQLEnumType({
      name: 'HeadingLevels',
      values: {
        h1: { value: 1 },
        h2: { value: 2 },
        h3: { value: 3 },
        h4: { value: 4 },
        h5: { value: 5 },
        h6: { value: 6 },
      },
    })

    return resolve({
      jsx: {
        type: GraphQLString,
        resolve(markdownNode) {
          return getJSX(markdownNode)
        },
      },
      mdxHast: {
        type: GraphQLJSON,
        resolve(markdownNode) {
          return getMdxHAST(markdownNode).then(ast => {
            const strippedAst = stripPosition(_.clone(ast), true)
            return hastReparseRaw(strippedAst)
          })
        },
      },
      excerpt: {
        type: GraphQLString,
        args: {
          pruneLength: {
            type: GraphQLInt,
            defaultValue: 140,
          },
        },
        resolve(markdownNode, { pruneLength }) {
          if (markdownNode.excerpt) {
            return Promise.resolve(markdownNode.excerpt)
          }
          return getAST(markdownNode).then(ast => {
            const excerptNodes = []
            visit(ast, node => {
              if (node.type === 'text' || node.type === 'inlineCode') {
                excerptNodes.push(node.value)
              }
            })

            return prune(excerptNodes.join(' '), pruneLength, '…')
          })
        },
      },
      headings: {
        type: new GraphQLList(HeadingType),
        args: {
          depth: {
            type: HeadingLevels,
          },
        },
        resolve(markdownNode, { depth }) {
          return getHeadings(markdownNode).then(headings => {
            if (typeof depth === 'number') {
              headings = headings.filter(heading => heading.depth === depth)
            }
            return headings
          })
        },
      },
      timeToRead: {
        type: GraphQLInt,
        resolve(markdownNode) {
          return getMdxHAST(markdownNode).then(html => {
            let timeToRead = 0
            const pureText = sanitizeHTML(html, { allowTags: [] })
            const avgWPM = 265
            const wordCount = _.words(pureText).length
            timeToRead = Math.round(wordCount / avgWPM)
            if (timeToRead === 0) {
              timeToRead = 1
            }
            return timeToRead
          })
        },
      },
      tableOfContents: {
        type: GraphQLString,
        resolve(markdownNode) {
          return getTableOfContents(markdownNode)
        },
      },
      // TODO add support for non-latin languages https://github.com/wooorm/remark/issues/251#issuecomment-296731071
      wordCount: {
        type: new GraphQLObjectType({
          name: 'wordCount',
          fields: {
            paragraphs: {
              type: GraphQLInt,
            },
            sentences: {
              type: GraphQLInt,
            },
            words: {
              type: GraphQLInt,
            },
          },
        }),
        resolve(markdownNode) {
          const counts = {}

          unified()
            .use(parse)
            .use(
              remark2retext,
              unified()
                .use(english)
                .use(count),
            )
            .use(stringify)
            .processSync(markdownNode.internal.content)

          return {
            paragraphs: counts.ParagraphNode,
            sentences: counts.SentenceNode,
            words: counts.WordNode,
          }

          function count() {
            return counter
            function counter(tree) {
              visit(tree, visitor)
              function visitor(node) {
                counts[node.type] = (counts[node.type] || 0) + 1
              }
            }
          }
        },
      },
    })
  })
}
