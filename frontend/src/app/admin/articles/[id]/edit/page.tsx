'use client';

import { useParams } from 'next/navigation';

import { ArticleEditorScreen } from '../../editor/ArticleEditorScreen';

export default function EditArticlePage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  return <ArticleEditorScreen articleId={Number.isFinite(id) ? id : null} />;
}
