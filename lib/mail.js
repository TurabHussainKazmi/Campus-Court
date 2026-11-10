'use strict';
// Email via Gmail + nodemailer (same provider as the original). Falls back to a
// console dry-run when no credentials are configured, so the app still works
// offline. Secrets stay on the server — never sent to the frontend.
const { esc } = require('./util');
const E = process.env;
const ADMIN_EMAIL = 'haroonsheik0127@gmail.com';

let mailer = null;
try {
  if (E.GMAIL_USER && E.GMAIL_APP_PASSWORD) {
    mailer = require('nodemailer').createTransport({
      service: 'gmail',
      auth: { user: E.GMAIL_USER, pass: E.GMAIL_APP_PASSWORD },
    });
  }
} catch { /* nodemailer not installed yet — dry-run */ }

function shell(heading, inner) {
  return `<div style="font-family:Georgia,serif;background:#14110e;color:#f4efe6;padding:30px;border-radius:16px;max-width:560px;margin:auto;border:1px solid #c9a24b55">
    <h2 style="color:#c9a24b;margin:0 0 16px">&#9878; Campus Court</h2>
    <h3 style="margin:0 0 12px">${heading}</h3>${inner}
    <p style="color:#9aa0c3;margin-top:22px;font-size:12px">CC by THE DARK TRIAD &middot; Sheikh Haroon, Turab &amp; Ruwail</p>
  </div>`;
}

async function send({ to, subject, html }) {
  const recipient = E.DEMO_EMAIL || to; // single-laptop demo: route all mail to one inbox
  if (!mailer) { console.log('[mail:dry-run] to', recipient, '|', subject); return { sent: false, dryRun: true }; }
  try {
    await mailer.sendMail({ from: `Campus Court <${E.GMAIL_USER}>`, to: recipient, subject, html });
    return { sent: true, to: recipient };
  } catch (e) {
    console.log('[mail:error]', e.message);
    return { sent: false, error: e.message };
  }
}

async function sendInvite({ to, caseTitle, inviter, link, hours }) {
  const html = shell('You have been summoned', `
    <p><b>${esc(inviter)}</b> has invited you to a Campus Court case: <i>${esc(caseTitle)}</i>.</p>
    <p>You have <b>${hours} hours</b> to accept before this invitation expires.</p>
    <p style="margin:22px 0"><a href="${esc(link)}" style="background:#c9a24b;color:#14110e;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:bold">Enter the Courtroom</a></p>
    <p style="color:#9aa0c3;font-size:12px">If the button fails, open this link: ${esc(link)}</p>`);
  return send({ to, subject: `⚖️ Summons: ${caseTitle}`, html });
}

async function sendAdminNotice(student) {
  const html = shell('New student registered', `
    <p>A new student joined Campus Court (auto-approved):</p>
    <table style="color:#f4efe6;font-size:14px">
      <tr><td style="padding:4px 12px;color:#9aa0c3">Name</td><td>${esc(student.name)}</td></tr>
      <tr><td style="padding:4px 12px;color:#9aa0c3">Roll</td><td>${esc(student.roll)}</td></tr>
      <tr><td style="padding:4px 12px;color:#9aa0c3">Email</td><td>${esc(student.email)}</td></tr>
      <tr><td style="padding:4px 12px;color:#9aa0c3">Phone</td><td>${esc(student.phone || '—')}</td></tr>
    </table>`);
  return send({ to: ADMIN_EMAIL, subject: `🎓 New registration: ${student.name} (${student.roll})`, html });
}

const enabled = () => !!mailer;

module.exports = { send, sendInvite, sendAdminNotice, enabled, ADMIN_EMAIL };