import { beforeEach, describe, expect, it } from 'vitest'
import {
  MESSAGES_KEY_PREFIX,
  SOURCES_KEY_PREFIX,
  clearMessages,
  findLatestNotebookWithMessages,
  loadMessages,
  loadSources,
  saveMessages,
  saveSources,
} from './chatStorage'
import type { Message, Source } from '../types'

describe('chatStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  const message: Message = {
    id: 'm1',
    role: 'user',
    content: '问题',
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
  }

  it('saves and restores messages with Date timestamps', () => {
    saveMessages('nb-1', [message], 'conv-1')

    const loaded = loadMessages('nb-1')

    expect(loaded.conversationId).toBe('conv-1')
    expect(loaded.messages[0].timestamp).toBeInstanceOf(Date)
    expect(loaded.messages[0].timestamp.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('returns an empty message state for invalid JSON', () => {
    localStorage.setItem(`${MESSAGES_KEY_PREFIX}nb-1`, '{bad')

    expect(loadMessages('nb-1')).toEqual({ messages: [], conversationId: null })
  })

  it('clears stored messages for a notebook', () => {
    saveMessages('nb-1', [message], null)
    clearMessages('nb-1')

    expect(localStorage.getItem(`${MESSAGES_KEY_PREFIX}nb-1`)).toBeNull()
  })

  it('finds the notebook with the newest stored message', () => {
    saveMessages('old', [{ ...message, timestamp: new Date('2026-01-01T00:00:00.000Z') }], null)
    saveMessages('new', [{ ...message, timestamp: new Date('2026-01-02T00:00:00.000Z') }], null)

    expect(findLatestNotebookWithMessages()).toBe('new')
  })

  it('ignores malformed latest-message entries', () => {
    localStorage.setItem(`${MESSAGES_KEY_PREFIX}bad`, '{bad')

    expect(findLatestNotebookWithMessages()).toBeNull()
  })

  it('saves and restores source cache', () => {
    const source: Source = { id: 'src-1', title: 'Source', notebook_id: 'nb-1', kind: 'document' }

    saveSources('nb-1', [source])

    expect(loadSources('nb-1')).toEqual([source])
    expect(localStorage.getItem(`${SOURCES_KEY_PREFIX}nb-1`)).toContain('src-1')
  })

  it('returns null for invalid source cache', () => {
    localStorage.setItem(`${SOURCES_KEY_PREFIX}nb-1`, '{bad')

    expect(loadSources('nb-1')).toBeNull()
  })
})
