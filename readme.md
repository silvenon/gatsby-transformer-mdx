# gatsby-transformer-mdx

**This project is no longer maintained, use [gatsby-mdx](https://github.com/ChristopherBiscardi/gatsby-mdx) instead.**

---

Gatsby transformer plugin for [MDX](https://github.com/mdx-js/mdx), heavily based on [gatsby-transformer-remark](https://github.com/gatsbyjs/gatsby/tree/master/packages/gatsby-transformer-remark).

## Installation

This package isn't published yet, you should link it in order to try it out:

```
git clone https://github.com/silvenon/gatsby-transformer-mdx
cd gatsby-transformer-mdx
yarn
yarn build
yarn link
cd ../your-gatsby-project
yarn link gatsby-transformer-mdx
```

Then add it to your `gatsby-config.js`:

```js
module.exports = {
  siteMetadata: {
    // ...
  },
  plugins: [
    {
      resolve: 'gatsby-source-filesystem',
      options: {
        name: 'posts',
        path: `${__dirname}/src/posts`,
      },
    },
    {
      resolve: 'gatsby-transformer-mdx',
      options: {
        remarkPlugins: [
          {
            resolve: 'gatsby-remark-smartypants',
            options: { dashes: 'oldschool' },
          },
        ],
      },
    },
  ]
}
```

## Use `.md` extension!

Currently `.mdx` isn't supported because the mime type for that extension doesn't exist yet. I'm trying to get `text/mdx` (or something similar) accepted into the database. [jshttp/mime-db#136](https://github.com/jshttp/mime-db/pull/136)
