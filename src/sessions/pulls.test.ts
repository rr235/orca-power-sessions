import { assert, test } from 'orca/testing'
import { infoOf } from './pulls'

test('reads a pull request\'s title and state from gh', () => {
  assert.deepEqual(infoOf('{"title":" fix: load repo issues ","state":"MERGED"}'), { title: 'fix: load repo issues', state: 'merged' })
  assert.equal(infoOf('not json'), null)
})
