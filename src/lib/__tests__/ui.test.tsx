// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from '../../App';

// The question lives in the URL, so each test must start from a clean address.
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.scrollTo = () => undefined;
});
afterEach(cleanup);

function askQuestion(text: string) {
  const input = screen.getByRole('searchbox') as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
}

describe('single page shell', () => {
  it('opens on one page with the ask box and no navigation tabs', () => {
    render(<App />);
    expect(screen.getByRole('searchbox')).toBeTruthy();
    expect(screen.queryAllByRole('link')).toHaveLength(1); // only the docs link
    expect(screen.getByText(/Ask your ChatGPT ads one question/i)).toBeTruthy();
  });

  it('answers a spend question inline on the same page', () => {
    render(<App />);
    askQuestion('How much did I spend this month?');
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toContain('You spent');
    expect(heading.textContent).toContain('₹');
    expect(screen.getByRole('searchbox')).toBeTruthy(); // still one page
  });

  it('renders an ad-group table for a ranking question', () => {
    render(<App />);
    askQuestion('Which ad group has the best cost per lead?');
    const table = screen.getAllByRole('table')[0];
    expect(within(table).getByText('Ad group')).toBeTruthy();
    expect(within(table).getByText('CPL')).toBeTruthy();
  });

  it('switches range chips and recomputes the headline', () => {
    render(<App />);
    askQuestion('How much did I spend?');
    const before = screen.getByRole('heading', { level: 1 }).textContent;
    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    const after = screen.getByRole('heading', { level: 1 }).textContent;
    expect(after).not.toBe(before);
    expect(after).toContain('7 days');
  });

  it('opens the research workspace from the research mode', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Research' }));
    askQuestion('gst filing and invoice automation');
    fireEvent.click(screen.getByRole('button', { name: /Cluster & score/i }));
    expect(screen.getAllByText(/Context-hint research/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Download CSV/i)).toBeTruthy();
  });

  it('says clearly that the data is demo, not a live account', async () => {
    render(<App />);
    // The health probe is async: wait for it to settle into demo mode.
    const bar = await screen.findByRole('button', { name: /Demo data/i });
    fireEvent.click(bar);
    expect(screen.getByText(/never sent to this browser/i)).toBeTruthy();
    expect(screen.getByText(/Advertiser key:/i)).toBeTruthy();
  });

  it('exports an answer: link, print and CSV are all offered', () => {
    render(<App />);
    askQuestion('What is my ROAS?');
    fireEvent.click(screen.getByRole('button', { name: /Share/i }));
    expect(screen.getByRole('menuitem', { name: /Copy link/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Print/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /CSV/i })).toBeTruthy();
  });

  it('offers follow-up questions that are answerable', () => {
    render(<App />);
    askQuestion('What is my ROAS?');
    const followUps = screen.getAllByRole('button').filter((b) => /CAC|lead|spend|campaign|Research context/i.test(b.textContent ?? ''));
    expect(followUps.length).toBeGreaterThan(2);
    fireEvent.click(followUps[0]);
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });
});
