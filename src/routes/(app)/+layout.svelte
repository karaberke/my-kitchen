<script lang="ts">
	import AssistantJobs from '$lib/components/AssistantJobs.svelte';

	let { data, children } = $props();
</script>

{@render children()}
<AssistantJobs initial={data.assistantJobs} />
