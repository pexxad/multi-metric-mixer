import { describe, expect, it } from 'vitest'
import { connectNodes, disconnectEdge, duplicateWorkflowStep, instantiateWorkflowTemplate, workflowHistoryReducer, workflowsEqual } from './App'
import { sampleWorkflow } from '../shared/workflow'

describe('shared Workflow editor state', () => {
  it('gives each unsaved template instance a globally unique Workflow ID', () => {
    const first = instantiateWorkflowTemplate(sampleWorkflow)
    const second = instantiateWorkflowTemplate(sampleWorkflow)
    expect(first.id).toMatch(/^wf_[a-f0-9]{32}$/)
    expect(second.id).not.toBe(first.id)
    expect(first.steps).toEqual(sampleWorkflow.steps)
    expect(sampleWorkflow.id).toBe('wf-rest-json-preview')
  })

  it('uses the same Workflow input fields for reconnect, disconnect, undo and redo', () => {
    const source = sampleWorkflow.steps.find((step) => step.kind === 'query')!
    const target = sampleWorkflow.steps.find((step) => step.kind === 'preview')!
    const disconnected = disconnectEdge(sampleWorkflow, { id: 'e', source: source.id, target: target.id })
    expect(disconnected.steps.find((step) => step.id === target.id)).toMatchObject({ input: null })
    const reconnected = connectNodes(disconnected, { source: source.id, target: target.id, sourceHandle: null, targetHandle: null })
    expect(reconnected.steps.find((step) => step.id === target.id)).toMatchObject({ input: source.id })
    const initial = { past: [], present: sampleWorkflow, future: [] }
    const edited = workflowHistoryReducer(initial, { type: 'edit', update: disconnected })
    expect(workflowHistoryReducer(edited, { type: 'undo' }).present).toEqual(sampleWorkflow)
    expect(workflowHistoryReducer(workflowHistoryReducer(edited, { type: 'undo' }), { type: 'redo' }).present).toEqual(disconnected)
  })

  it('duplicates a node in the shared Workflow definition', () => {
    const source = sampleWorkflow.steps[0]!
    const duplicated = duplicateWorkflowStep(sampleWorkflow, source.id, 'fetch-json-copy')
    expect(duplicated.steps[1]).toMatchObject({ id: 'fetch-json-copy', kind: source.kind, title: `${source.title} のコピー` })
  })

  it('treats a server-normalized Workflow with different property order as saved', () => {
    const reordered = { steps: sampleWorkflow.steps.map((step) => structuredClone(step)), description: sampleWorkflow.description,
      name: sampleWorkflow.name, id: sampleWorkflow.id, version: 1 as const }
    expect(workflowsEqual(sampleWorkflow, reordered)).toBe(true)
  })
})
