/**
 * Vercel serverless function handler
 * Exports the Express app for Vercel deployment
 */

const app = require('../server');

module.exports = app;

