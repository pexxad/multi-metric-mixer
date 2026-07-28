import type { DataModel } from './data-source'

export type PublicConnectionProfile = {
  id: string
  displayName: string
  dataModel: DataModel
}
