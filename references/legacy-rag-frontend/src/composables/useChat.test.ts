import { beforeEach, describe, expect, it } from 'vitest'
import { mergeReferences, selectAllSources, selectedSourceIds, sources, toggleSourceSelection } from './useChat'
import type { ChatReference, Source } from '../types'

function source(id: string): Source {
  return { id, title: id, notebook_id: 'nb-1', kind: 'document' }
}

function reference(citationNumber: number): ChatReference {
  return {
    citation_number: citationNumber,
    source_id: `source-${citationNumber}`,
    cited_text: null,
    start_char: null,
    end_char: null,
  }
}

describe('source selection actions', () => {
  beforeEach(() => {
    sources.value = [source('a'), source('b')]
    selectedSourceIds.value = ['a', 'b']
  })

  it('does not unselect the final selected source', () => {
    selectedSourceIds.value = ['a']

    toggleSourceSelection('a')

    expect(selectedSourceIds.value).toEqual(['a'])
  })

  it('removes a selected source when more than one source is selected', () => {
    toggleSourceSelection('a')

    expect(selectedSourceIds.value).toEqual(['b'])
  })

  it('adds an unselected source', () => {
    selectedSourceIds.value = ['a']

    toggleSourceSelection('b')

    expect(selectedSourceIds.value).toEqual(['a', 'b'])
  })

  it('selects all sources', () => {
    selectedSourceIds.value = ['a']

    selectAllSources()

    expect(selectedSourceIds.value).toEqual(['a', 'b'])
  })
})

describe('mergeReferences', () => {
  it('keeps existing references and appends new citation numbers only', () => {
    expect(mergeReferences([reference(1)], [reference(1), reference(2)])).toEqual([
      reference(1),
      reference(2),
    ])
  })
})
