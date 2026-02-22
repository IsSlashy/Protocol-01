import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import { Colors, FontFamily, FontSize } from '@/constants/theme';

interface MarkdownBubbleProps {
  content: string;
}

/**
 * Lightweight markdown renderer for chat bubbles.
 * Handles: **bold**, *italic*, `code`, ```codeblock```, - lists, # headers
 * No external dep needed — pure RN.
 */
export const MarkdownBubble: React.FC<MarkdownBubbleProps> = ({ content }) => {
  const elements = useMemo(() => parseMarkdown(content), [content]);
  return <>{elements}</>;
};

function parseMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeBlockLines: string[] = [];
  let key = 0;

  for (const line of lines) {
    // Code block toggle
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        // End code block
        elements.push(
          <View
            key={key++}
            style={{
              backgroundColor: 'rgba(0,0,0,0.4)',
              borderRadius: 8,
              padding: 10,
              marginVertical: 4,
              borderWidth: 1,
              borderColor: 'rgba(57,197,187,0.15)',
            }}
          >
            <Text
              style={{
                color: Colors.primary,
                fontFamily: FontFamily.mono,
                fontSize: FontSize.xs,
                lineHeight: 18,
              }}
            >
              {codeBlockLines.join('\n')}
            </Text>
          </View>
        );
        codeBlockLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      elements.push(
        <Text
          key={key++}
          style={{
            color: Colors.text,
            fontSize: level === 1 ? FontSize.lg : level === 2 ? FontSize.md : FontSize.sm,
            fontFamily: FontFamily.bold,
            marginTop: 6,
            marginBottom: 2,
          }}
        >
          {renderInline(headerMatch[2])}
        </Text>
      );
      continue;
    }

    // Bullet list
    if (line.match(/^\s*[-*]\s+/)) {
      const bulletText = line.replace(/^\s*[-*]\s+/, '');
      elements.push(
        <View key={key++} style={{ flexDirection: 'row', marginVertical: 1, paddingLeft: 4 }}>
          <Text style={{ color: Colors.primary, fontSize: FontSize.sm, marginRight: 6 }}>
            {'\u2022'}
          </Text>
          <Text style={{ color: Colors.text, fontSize: FontSize.sm, flex: 1, lineHeight: 20 }}>
            {renderInline(bulletText)}
          </Text>
        </View>
      );
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      elements.push(<View key={key++} style={{ height: 6 }} />);
      continue;
    }

    // Regular paragraph
    elements.push(
      <Text
        key={key++}
        style={{ color: Colors.text, fontSize: FontSize.sm, lineHeight: 20, marginVertical: 1 }}
      >
        {renderInline(line)}
      </Text>
    );
  }

  // Unclosed code block
  if (inCodeBlock && codeBlockLines.length > 0) {
    elements.push(
      <View
        key={key++}
        style={{
          backgroundColor: 'rgba(0,0,0,0.4)',
          borderRadius: 8,
          padding: 10,
          marginVertical: 4,
        }}
      >
        <Text style={{ color: Colors.primary, fontFamily: FontFamily.mono, fontSize: FontSize.xs }}>
          {codeBlockLines.join('\n')}
        </Text>
      </View>
    );
  }

  return elements;
}

function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Regex for **bold**, *italic*, `code`
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)/g;
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    // Text before match
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }

    if (match[2]) {
      // **bold**
      parts.push(
        <Text key={key++} style={{ fontFamily: FontFamily.bold, color: Colors.text }}>
          {match[2]}
        </Text>
      );
    } else if (match[4]) {
      // *italic*
      parts.push(
        <Text key={key++} style={{ fontStyle: 'italic', color: Colors.text }}>
          {match[4]}
        </Text>
      );
    } else if (match[6]) {
      // `code`
      parts.push(
        <Text
          key={key++}
          style={{
            fontFamily: FontFamily.mono,
            color: Colors.primary,
            backgroundColor: 'rgba(57,197,187,0.1)',
            paddingHorizontal: 3,
            borderRadius: 3,
            fontSize: FontSize.xs,
          }}
        >
          {match[6]}
        </Text>
      );
    }
    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

export default MarkdownBubble;
