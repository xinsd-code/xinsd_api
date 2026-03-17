import { NextResponse } from 'next/server';
import { OrchestrationConfig } from '@/lib/types';
import { applyOrchestration, applyNode, applyOrchestrationUpTo } from '@/lib/orchestration-engine';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { sampleData, orchestration, mode, nodeId, context } = body as {
      sampleData: any;
      orchestration: OrchestrationConfig;
      mode: 'single' | 'full' | 'upto';
      nodeId?: string;
      context?: Record<string, any>;
    };

    if (!orchestration || !orchestration.nodes || orchestration.nodes.length === 0) {
      return NextResponse.json({
        result: sampleData,
        message: 'No orchestration nodes configured'
      });
    }

    if (mode === 'single' && nodeId) {
      // Execute single node only
      const node = orchestration.nodes.find(n => n.id === nodeId);
      if (!node) {
        return NextResponse.json({ error: `Node ${nodeId} not found` }, { status: 404 });
      }
      const result = applyNode(sampleData, node, context);
      return NextResponse.json({ result, nodeId });
    }

    if (mode === 'upto' && nodeId) {
      // Execute up to a specific node
      const { result, nodeResults } = applyOrchestrationUpTo(sampleData, orchestration, nodeId, context);
      return NextResponse.json({ result, nodeResults, nodeId });
    }

    // Full mode: execute all nodes in order
    const result = applyOrchestration(sampleData, orchestration, context);
    return NextResponse.json({ result });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
