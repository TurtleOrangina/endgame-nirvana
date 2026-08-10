// @vitest-environment node
import { describe, expect, test } from 'vite-plus/test'
import { formatYaml, parseMappingList } from '../yaml'

describe('formatYaml', () => {
  test('puts a list entrys first key on the dash line', () => {
    const yaml = formatYaml({
      puzzles: [{ fen: 'a', playouts: [{ moves: '1. e4' }] }],
    })

    expect(yaml).toBe(
      'puzzles:\n' + //
        '  - fen: "a"\n' +
        '    playouts:\n' +
        '      - { moves: "1. e4" }\n',
    )
  })
})

describe('parseMappingList', () => {
  test('reads back what formatYaml wrote, nested lists and all', () => {
    const rows = parseMappingList(
      formatYaml({
        seed: 1,
        puzzles: [
          { fen: 'a', men: 8, playouts: [{ moves: '1. e4' }, { moves: '1. d4' }] },
          { fen: 'b', men: 5, playouts: [{ moves: '1... Kb2' }] },
        ],
        trailing: 'ignored',
      }),
      'puzzles',
    )

    expect(rows).toEqual([
      { fen: 'a', men: 8 },
      { fen: 'b', men: 5 },
    ])
  })

  test('still reads the flow-mapping rows older baselines are written as', () => {
    const rows = parseMappingList(
      'puzzles:\n  - { fen: "a", men: 8 }\n  - { fen: "b", men: 5 }\nseed: 1\n',
      'puzzles',
    )

    expect(rows).toEqual([
      { fen: 'a', men: 8 },
      { fen: 'b', men: 5 },
    ])
  })

  test('fails loudly when the list is missing', () => {
    expect(() => parseMappingList('seed: 1\n', 'puzzles')).toThrow('No "puzzles:" list found')
  })
})
