import { describe, expect, test } from 'vite-plus/test'
import { createUciSearchCollector } from '@/utils/uciSearchCollector'

describe('smoke', () => {
  test('collector parses a multipv info line', () => {
    const collector = createUciSearchCollector()
    collector.consumeInfo('info depth 12 multipv 1 score cp 34 pv e2e4 e7e5')
    expect(collector.finish('bestmove e2e4')).toEqual([
      { moves: ['e2e4', 'e7e5'], scoreCP: 34, scoreMate: null, depth: 12, multipvIndex: 1 },
    ])
  })
})
