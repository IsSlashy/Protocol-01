/**
 * Custom render wrapper that ensures React 18 is used consistently.
 *
 * Works around the monorepo React 18/19 version conflict by importing
 * react and react-dom from the local extension node_modules explicitly.
 */

import React from 'react';
import ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';

export { React };

interface RenderResult {
  container: HTMLElement;
  unmount: () => void;
  getByText: (text: string | RegExp) => Element;
  getAllByText: (text: string | RegExp) => Element[];
  queryByText: (text: string | RegExp) => Element | null;
  getByPlaceholderText: (text: string) => Element;
  getByTestId: (id: string) => Element;
  getAllByRole: (role: string) => Element[];
  getByRole: (role: string, options?: { name?: string | RegExp }) => Element;
}

function matchesText(el: Element, text: string | RegExp): boolean {
  const content = el.textContent || '';
  if (typeof text === 'string') return content === text;
  return text.test(content);
}

function deepQueryByText(container: Element, text: string | RegExp): Element[] {
  const results: Element[] = [];
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_ELEMENT,
    null,
  );
  let node = walker.nextNode() as Element | null;
  while (node) {
    // Only match leaf text nodes (nodes where textContent matches directly)
    if (node.children.length === 0 && matchesText(node, text)) {
      results.push(node);
    } else if (matchesText(node, text)) {
      // Also check parent nodes for combined text
      results.push(node);
    }
    node = walker.nextNode() as Element | null;
  }
  return results;
}

export function render(ui: React.ReactElement): RenderResult {
  const container = document.createElement('div');
  document.body.appendChild(container);

  act(() => {
    ReactDOM.render(ui, container);
  });

  const unmount = () => {
    act(() => {
      ReactDOM.unmountComponentAtNode(container);
    });
    container.remove();
  };

  const getByText = (text: string | RegExp) => {
    const results = deepQueryByText(container, text);
    if (results.length === 0) throw new Error(`Unable to find element with text: ${text}`);
    return results[0];
  };

  const getAllByText = (text: string | RegExp) => {
    const results = deepQueryByText(container, text);
    if (results.length === 0) throw new Error(`Unable to find elements with text: ${text}`);
    return results;
  };

  const queryByText = (text: string | RegExp) => {
    const results = deepQueryByText(container, text);
    return results.length > 0 ? results[0] : null;
  };

  const getByPlaceholderText = (text: string) => {
    const el = container.querySelector(`[placeholder="${text}"]`);
    if (!el) throw new Error(`Unable to find element with placeholder: ${text}`);
    return el;
  };

  const getByTestId = (id: string) => {
    const el = container.querySelector(`[data-testid="${id}"]`);
    if (!el) throw new Error(`Unable to find element with data-testid: ${id}`);
    return el;
  };

  const getAllByRole = (role: string) => {
    // Simple role mapping for common elements
    const roleMap: Record<string, string> = {
      button: 'button, [role="button"]',
      img: 'img, [role="img"]',
      link: 'a, [role="link"]',
      textbox: 'input[type="text"], input:not([type]), textarea, [role="textbox"]',
    };
    const selector = roleMap[role] || `[role="${role}"]`;
    return Array.from(container.querySelectorAll(selector));
  };

  const getByRole = (role: string, options?: { name?: string | RegExp }) => {
    const all = getAllByRole(role);
    if (options?.name) {
      const match = all.find((el) => {
        const label = el.getAttribute('aria-label') || el.textContent || '';
        if (typeof options.name === 'string') return label.includes(options.name);
        return options.name!.test(label);
      });
      if (!match) throw new Error(`Unable to find element with role: ${role} and name: ${options.name}`);
      return match;
    }
    if (all.length === 0) throw new Error(`Unable to find element with role: ${role}`);
    return all[0];
  };

  return { container, unmount, getByText, getAllByText, queryByText, getByPlaceholderText, getByTestId, getAllByRole, getByRole };
}

export function fireEvent(el: Element, event: Event) {
  act(() => {
    el.dispatchEvent(event);
  });
}

fireEvent.click = (el: Element) => {
  fireEvent(el, new MouseEvent('click', { bubbles: true }));
};

fireEvent.change = (el: Element, options: { target: { value: string } }) => {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(el, options.target.value);
  } else {
    (el as HTMLInputElement).value = options.target.value;
  }
  fireEvent(el, new Event('input', { bubbles: true }));
  fireEvent(el, new Event('change', { bubbles: true }));
};

fireEvent.keyPress = (el: Element, options: { key: string; charCode: number }) => {
  fireEvent(el, new KeyboardEvent('keypress', { ...options, bubbles: true }));
};

export { act };
export const screen = {
  getByText: (text: string | RegExp) => {
    const results = deepQueryByText(document.body, text);
    if (results.length === 0) throw new Error(`Unable to find element with text: ${text}`);
    return results[0];
  },
  getAllByText: (text: string | RegExp) => {
    const results = deepQueryByText(document.body, text);
    if (results.length === 0) throw new Error(`Unable to find elements with text: ${text}`);
    return results;
  },
  queryByText: (text: string | RegExp) => {
    const results = deepQueryByText(document.body, text);
    return results.length > 0 ? results[0] : null;
  },
  getByPlaceholderText: (text: string) => {
    const el = document.body.querySelector(`[placeholder="${text}"]`);
    if (!el) throw new Error(`Unable to find element with placeholder: ${text}`);
    return el;
  },
  getByTestId: (id: string) => {
    const el = document.body.querySelector(`[data-testid="${id}"]`);
    if (!el) throw new Error(`Unable to find element with data-testid: ${id}`);
    return el;
  },
  getAllByRole: (role: string) => {
    const roleMap: Record<string, string> = {
      button: 'button, [role="button"]',
      img: 'img, [role="img"]',
      link: 'a, [role="link"]',
    };
    const selector = roleMap[role] || `[role="${role}"]`;
    return Array.from(document.body.querySelectorAll(selector));
  },
};

export async function waitFor(callback: () => void | Promise<void>, options?: { timeout?: number }) {
  const timeout = options?.timeout || 3000;
  const start = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - start < timeout) {
    try {
      await callback();
      return;
    } catch (e) {
      lastError = e as Error;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  throw lastError || new Error('waitFor timed out');
}
