import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DaisyMarket, reputationStatus, uploadDataset } from "../daisy/DaisyMarket";
import { nextSampleUpload, sampleDaisy } from "../daisy/sampleData";

/**
 * #flower: a preview of the DaisyMarket component with sample data. This page plays the host app:
 * it owns the datasets and the reputation and passes them in; the component only draws and animates.
 */
export function FlowerPreview() {
  const [state, setState] = useState(sampleDaisy);
  const [reputation, setReputation] = useState(87);
  const rep = reputationStatus(reputation);

  return (
    <div className="flower-preview">
      <div className="flower-controls">
        <Button onClick={() => setState(s => uploadDataset(s, nextSampleUpload()))}>Upload new data</Button>
        <label className="flower-rep">
          Reputation <strong>{rep.value}% · {rep.label}</strong>
          <input type="range" min={0} max={100} value={reputation} onChange={e => setReputation(Number(e.target.value))} />
        </label>
        <div className="flower-presets">
          {[32, 62, 87].map(v => <Button key={v} variant="outline" size="sm" onClick={() => setReputation(v)}>{v}%</Button>)}
        </div>
      </div>
      <DaisyMarket
        {...state}
        reputation={reputation}
        label="WhaleWatcher's datasets"
        renderActions={(d, kind) => kind === "active" ? <Button size="sm">Buy · {d.price}</Button> : null}
      />
    </div>
  );
}
