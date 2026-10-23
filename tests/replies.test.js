const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../reply-templates.js');
const { analyze, classify, draft, templates, defaults } = globalThis.ReplyTemplates;

const outreach = (text, extra = {}) => ({
  threadTitle: 'Federica Maino',
  viewerName: 'Pieter Becking',
  messages: [{ sender: 'Federica Maino', text }],
  ...extra,
});

test('recognizes the engineering-services pitch from the screenshot', () => {
  const text = 'Hey Pieter, I came across Servo7’s container-unloading robots. As you scale deployments, Robotic Crew can help with additional engineering talent in software, embedded systems, and QA. Could extra capacity be useful as the team grows?';
  const result = analyze(outreach(text));
  assert.equal(result.kind, 'services');
  assert.match(draft(result.kind, result.sender), /^Hey Federica,/);
  assert.match(draft(result.kind, result.sender), /external engineering support/);
});

test('recognizes recruiter and investor requests', () => {
  for (const text of [
    'I run a recruitment agency. Can we help with hiring?',
    'We help teams hire engineers.',
    'Can I help with your hiring needs?',
    'We specialize in executive search.',
  ]) assert.equal(classify(text), 'recruiter', text);
  for (const text of [
    'We invest in early-stage robotics companies. Would love to chat.',
    "I'm an investor at Example. Can we connect?",
    'I work at a venture capital firm and would love to meet.',
    'When is your next fundraise?',
    'Are you planning to raise again soon?',
  ]) assert.equal(classify(text), 'investor', text);
});

test('does not infer outreach from generic business words or mixed pitches', () => {
  for (const text of [
    'I love your product. How is the team growing?',
    'Could we discuss a customer deployment next week?',
    'Thanks! Keep me posted.',
    'Our customers invest a lot of time in software.',
    'We are hiring an engineer internally.',
    'I run a recruitment agency for a venture capital firm.',
  ]) assert.equal(classify(text), null, text);
});

test('uses consecutive incoming bubbles and stops at the previous outgoing reply', () => {
  const thread = outreach('', { messages: [
    { sender: 'Federica Maino', text: 'We invest in robotics companies.' },
    { sender: 'Federica Maino', text: 'Would you be open to a chat?' },
  ] });
  assert.equal(analyze(thread).kind, 'investor');
  thread.messages.push(
    { sender: 'Pieter Becking', text: 'Happy to keep you posted.' },
    { sender: 'Federica Maino', text: 'Thanks, sounds good!' },
  );
  assert.equal(analyze(thread).kind, null);
  assert.equal(analyze(thread).message, 'Thanks, sounds good!');
});

test('does not draft a rejection after we have already replied', () => {
  for (const own of [
    { sender: 'Pieter Becking' },
    { sender: 'You' },
    { sender: 'Pieter', isOutgoing: true },
  ]) {
    const result = analyze(outreach('', { messages: [
      { sender: 'Federica Maino', text: 'We invest in robotics.' },
      { ...own, text: 'Thanks for reaching out!' },
    ] }));
    assert.equal(result.kind, null);
    assert.equal(result.reason, 'replied');
  }
});

test('requires a verified one-to-one identity for automatic replies', () => {
  assert.equal(analyze(outreach('I am an investor', { isGroup: true })).kind, null);
  assert.equal(analyze(outreach('I am an investor', { threadTitle: 'Project chat' })).kind, null);
  assert.equal(analyze(outreach('I am an investor', { threadTitle: null })).kind, null);
  assert.equal(analyze(outreach('', { messages: [] })).reason, 'empty');
  assert.equal(analyze(outreach('', { messages: [{ sender: 'Unknown', text: 'I am an investor' }] })).sender, 'Federica Maino');
});

test('custom templates and safe literal greetings work without credentials', () => {
  assert.equal(draft('investor', 'Zoë van Dijk', { investor: 'Hi {firstName}! {firstName}, let’s stay in touch.' }), 'Hi Zoë! Zoë, let’s stay in touch.');
  assert.equal(draft('services', '', { services: 'Hey {firstName}!' }), 'Hey there!');
  assert.equal(draft('services', '$&', { services: 'Hey {firstName}!' }), 'Hey $&!');
  assert.equal(draft('unknown', 'Federica'), '');
  assert.equal(templates({ recruiter: ' ', investor: 42 }).investor, defaults.investor);
  assert.equal(templates({ recruiter: ' ', investor: 42 }).recruiter, defaults.recruiter);
});
