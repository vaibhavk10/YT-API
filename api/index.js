/**
 * Vercel serverless function handler
 * Exports the Express app for Vercel deployment
 */

// Set Vercel environment flag before requiring server
process.env.VERCEL = '1';

const app = require('../server');

// Vercel's @vercel/node can handle Express apps directly
module.exports = app;

