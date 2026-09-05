import { defineConfig } from "vitepress";

export default defineConfig({
  // The runtime serves this site at /docs/. A different deployment can set
  // DOCS_BASE without a source change.
  base: process.env.DOCS_BASE ?? "/docs/",
  title: "WorldFixture",
  description: "Stateful local provider services for development, demos, and CI.",
  cleanUrls: true,
  // The runtime image does not include Git. Keep the docs build reproducible
  // in that small image instead of deriving page dates from a checkout.
  lastUpdated: false,
  ignoreDeadLinks: false,
  themeConfig: {
    siteTitle: "WorldFixture docs",
    search: { provider: "local" },
    nav: [
      { text: "Quick start", link: "/getting-started/quick-start" },
      { text: "Use WorldFixture", link: "/guides/worlds" },
      { text: "How it works", link: "/architecture" },
      { text: "API support", link: "/providers/" },
      {
        text: "Contributors",
        items: [
          { text: "Contract testing", link: "/contract-testing" },
          { text: "Add a provider", link: "/providers/adding-a-provider" },
          { text: "Connector protocol", link: "/connectors/overview" },
        ],
      },
    ],
    sidebar: {
      "/providers/": [
        {
          text: "API support",
          items: [
          { text: "Support index", link: "/providers/" },
          { text: "How support is measured", link: "/providers/support-policy" },
          ],
        },
        {
          text: "Provider details",
          collapsed: true,
          items: [
          { text: "Slack", link: "/providers/slack" },
          { text: "GitHub", link: "/providers/github" },
          { text: "Google", link: "/providers/google" },
          { text: "Notion", link: "/providers/notion" },
          { text: "Stripe", link: "/providers/stripe" },
          { text: "Apple", link: "/providers/apple" },
          { text: "AWS", link: "/providers/aws" },
          { text: "Clerk", link: "/providers/clerk" },
          { text: "Linear", link: "/providers/linear" },
          { text: "Microsoft", link: "/providers/microsoft" },
          { text: "MongoDB Atlas", link: "/providers/mongodb-atlas" },
          { text: "Okta", link: "/providers/okta" },
          { text: "Resend", link: "/providers/resend" },
          { text: "Twilio", link: "/providers/twilio" },
          { text: "Vercel", link: "/providers/vercel" },
          { text: "Local Mail", link: "/providers/local-mail" },
          { text: "S3", link: "/providers/s3" },
          { text: "Databases", link: "/providers/databases" },
          ],
        },
      ],
      "/getting-started/": [
        {
          text: "Start",
          items: [
            { text: "Five-minute quick start", link: "/getting-started/quick-start" },
            { text: "Connect an application", link: "/getting-started/connect-an-app" },
            { text: "Troubleshooting", link: "/getting-started/troubleshooting" },
          ],
        },
      ],
      "/guides/": [
        {
          text: "Use WorldFixture",
          items: [
            { text: "How worlds work", link: "/guides/worlds" },
            { text: "Workbench", link: "/guides/workbench" },
            { text: "Bindings", link: "/guides/bindings" },
            { text: "Events and webhooks", link: "/guides/events-and-webhooks" },
            { text: "Reset and persistence", link: "/guides/reset-and-persistence" },
            { text: "HTTP targets and RSS", link: "/guides/http-targets" },
          ],
        },
      ],
      "/": [
        {
          text: "Start here",
          items: [
            { text: "What is WorldFixture?", link: "/" },
            { text: "Five-minute quick start", link: "/getting-started/quick-start" },
            { text: "How it works", link: "/architecture" },
            { text: "Workbench", link: "/guides/workbench" },
            { text: "API support", link: "/providers/" },
          ],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: "https://github.com/ben-ic/worldfixture" }],
    footer: { message: "Local, synthetic, and resettable.", copyright: "Apache-2.0" },
  },
});
